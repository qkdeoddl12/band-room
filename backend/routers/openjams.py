"""오픈 잼 — 1곡 단위 자율 합주 매칭.

로그인이 없으므로 신원은 예약 페이지와 같은 방식으로 확인한다:
이름을 받아 활동 중인 멤버에서 찾고(`find_member_by_name`), 동명이인이면 막는다.
발제자·지원자 본인 확인은 예약 취소와 같은 토큰 방식이다 —
토큰은 **생성 응답에만** 실어 보내고 목록에는 절대 싣지 않는다.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, joinedload
from datetime import datetime
from typing import List
import secrets

from database import get_db
from app_logging import log_event
from deps import get_current_admin, audit, get_or_404
import models
import schemas

router = APIRouter(tags=["openjams"])


def _resolve_member(db: Session, name: str):
    """이름으로 활동 멤버를 찾는다. 오픈 잼은 도어즈 안에서 도는 것이라
    명부에 없는 사람은 받지 않는다 — 이게 사실상 유일하면서 충분한 방어다."""
    # 순환 import 를 피해 예약 라우터의 것을 그대로 쓴다 (규칙이 갈리면 안 된다).
    from routers.reservations import find_member_by_name

    member, ambiguous = find_member_by_name(db, name)
    if ambiguous:
        raise HTTPException(400, "같은 이름의 멤버가 여러 명입니다. 문의하기로 접수해주세요.")
    if not member:
        raise HTTPException(400, "도어즈 멤버 명단에 없는 이름입니다. 문의하기로 알려주세요.")
    return member


def _jam_query(db: Session):
    return db.query(models.OpenJam).options(
        joinedload(models.OpenJam.slots).joinedload(models.OpenJamSlot.member)
    )


def _sorted(jam: models.OpenJam) -> models.OpenJam:
    jam.slots.sort(key=lambda s: (s.sort_order, s.id))
    return jam


def _check_token(stored, given, message="권한이 없습니다."):
    """compare_digest 로 맞춘다 — 글자 수 비교로 토큰을 조금씩 알아내지 못하게."""
    if not stored or not secrets.compare_digest(stored, given):
        raise HTTPException(403, message)


# ========== 공개 ==========
@router.get("/api/openjams", response_model=List[schemas.OpenJamPublic])
def list_openjams(db: Session = Depends(get_db)):
    """모집중·모집완료만. 종료된 잼은 목록에서 내린다."""
    jams = _jam_query(db).filter(
        models.OpenJam.status.in_(('recruiting', 'closed'))
    ).order_by(models.OpenJam.created_at.desc()).all()
    return [_sorted(j) for j in jams]


@router.post("/api/openjams", response_model=schemas.OpenJamCreated)
def create_openjam(
    data: schemas.OpenJamCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    leader = _resolve_member(db, data.leader_name)

    jam = models.OpenJam(
        title=data.title.strip(),
        leader_member_id=leader.id,
        leader_name=leader.name,
        target_period=(data.target_period or '').strip() or None,
        memo=(data.memo or '').strip() or None,
        manage_token=secrets.token_hex(16),
    )
    db.add(jam)
    db.flush()

    order = 0
    for row in data.slots:
        part = row.part.strip()
        if not part:
            continue
        # "기타 2" 는 자리 두 개다. 자리 단위로 두어야 선착순이 단순해진다.
        for _ in range(row.count):
            db.add(models.OpenJamSlot(jam_id=jam.id, part=part, sort_order=order))
            order += 1
    if order == 0:
        raise HTTPException(400, "모집할 포지션을 한 개 이상 넣어주세요.")

    db.commit()
    db.refresh(jam)
    log_event("openjam_created", id=jam.id, title=jam.title, leader=jam.leader_name,
              slots=order, client=request.client.host if request.client else None)
    return _sorted(jam)


@router.post("/api/openjam-slots/{slot_id}/claim", response_model=schemas.OpenJamClaimed)
def claim_slot(
    slot_id: int,
    data: schemas.OpenJamClaim,
    request: Request,
    db: Session = Depends(get_db),
):
    """선착순 지원. 두 명이 동시에 눌러도 한 명만 들어가야 하므로
    조건부 UPDATE(빈 자리일 때만) 로 잡고, 못 잡으면 이미 찬 것이다."""
    slot = get_or_404(db, models.OpenJamSlot, slot_id, "그런 자리가 없습니다.")
    jam = get_or_404(db, models.OpenJam, slot.jam_id, "그런 오픈 잼이 없습니다.")
    if jam.status != 'recruiting':
        raise HTTPException(400, "모집이 끝난 오픈 잼입니다.")

    member = _resolve_member(db, data.name)
    if any(s.member_id == member.id for s in jam.slots):
        raise HTTPException(400, "이미 이 오픈 잼에 참여하고 있습니다.")

    token = secrets.token_hex(16)
    taken = db.query(models.OpenJamSlot).filter(
        models.OpenJamSlot.id == slot_id,
        models.OpenJamSlot.member_id.is_(None),
    ).update(
        {
            "member_id": member.id,
            "member_name": member.name,
            "claim_token": token,
            "claimed_at": datetime.now(),
        },
        synchronize_session=False,
    )
    if not taken:
        db.rollback()
        raise HTTPException(400, "방금 다른 분이 먼저 지원했습니다. 새로고침 후 다른 자리를 봐주세요.")
    db.commit()
    db.refresh(slot)

    log_event("openjam_claimed", jam_id=jam.id, slot_id=slot_id, part=slot.part,
              member=member.name, client=request.client.host if request.client else None)
    return schemas.OpenJamClaimed(
        slot_id=slot.id, jam_id=jam.id, part=slot.part,
        member_name=slot.member_name, claim_token=token,
    )


@router.post("/api/openjam-slots/{slot_id}/release")
def release_slot(
    slot_id: int,
    data: schemas.OpenJamToken,
    db: Session = Depends(get_db),
):
    slot = get_or_404(db, models.OpenJamSlot, slot_id, "그런 자리가 없습니다.")
    _check_token(slot.claim_token, data.token, "이 자리를 취소할 권한이 없습니다.")

    name = slot.member_name
    slot.member_id = None
    slot.member_name = None
    slot.claim_token = None
    slot.claimed_at = None
    db.commit()
    log_event("openjam_released", jam_id=slot.jam_id, slot_id=slot_id, member=name)
    return {"message": "지원을 취소했습니다."}


@router.post("/api/openjams/{jam_id}/status", response_model=schemas.OpenJamPublic)
def set_openjam_status(
    jam_id: int,
    data: schemas.OpenJamStatusChange,
    db: Session = Depends(get_db),
):
    """발제자가 진행 상태를 옮긴다.

      recruiting  모집중 — 자리를 더 받는다
      closed      모집완료 — 인원 확정. 이 상태여야 합주실을 예약할 수 있다
      done        종료 — 합주가 끝났다. **목록에서 내려간다**

    하차가 생기면 closed → recruiting 으로 되돌려 다시 받을 수 있어야 한다
    (기획서도 하차를 전제한다). 되살리기(done → 그 외)는 관리자 몫이다."""
    jam = _jam_query(db).filter(models.OpenJam.id == jam_id).first()
    if not jam:
        raise HTTPException(404, "그런 오픈 잼이 없습니다.")
    _check_token(jam.manage_token, data.token, "이 오픈 잼을 바꿀 권한이 없습니다.")
    if jam.status == 'done':
        raise HTTPException(400, "이미 종료된 오픈 잼입니다. 되살리려면 문의해주세요.")

    jam.status = data.status
    db.commit()
    db.refresh(jam)
    log_event("openjam_status", id=jam.id, title=jam.title, status=jam.status)
    return _sorted(jam)


@router.delete("/api/openjams/{jam_id}")
def delete_openjam(
    jam_id: int,
    token: str,
    db: Session = Depends(get_db),
):
    jam = _jam_query(db).filter(models.OpenJam.id == jam_id).first()
    if not jam:
        raise HTTPException(404, "그런 오픈 잼이 없습니다.")
    _check_token(jam.manage_token, token, "이 오픈 잼을 지울 권한이 없습니다.")
    if any(s.member_id for s in jam.slots):
        raise HTTPException(400, "이미 지원한 분이 있어 지울 수 없습니다. 모집 마감 후 진행해주세요.")

    title = jam.title
    db.delete(jam)
    db.commit()
    log_event("openjam_deleted", id=jam_id, title=title)
    return {"message": "삭제되었습니다."}


# ========== 관리자 ==========
def _admin_view(jam: models.OpenJam) -> schemas.OpenJamAdmin:
    _sorted(jam)
    return schemas.OpenJamAdmin(
        id=jam.id, title=jam.title,
        leader_name=jam.leader_name,
        leader_phone=jam.leader.phone if jam.leader else None,
        target_period=jam.target_period, memo=jam.memo,
        status=jam.status, created_at=jam.created_at,
        slots=[
            schemas.OpenJamAdminSlot(
                id=s.id, part=s.part, sort_order=s.sort_order,
                member_name=s.member_name, member_id=s.member_id,
                member_phone=s.member.phone if s.member else None,
                claimed_at=s.claimed_at,
            )
            for s in jam.slots
        ],
    )


@router.get("/api/admin/openjams", response_model=List[schemas.OpenJamAdmin])
def list_openjams_admin(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    jams = _jam_query(db).options(
        joinedload(models.OpenJam.leader)
    ).order_by(models.OpenJam.created_at.desc()).all()
    return [_admin_view(j) for j in jams]


@router.patch("/api/admin/openjams/{jam_id}", response_model=schemas.OpenJamAdmin)
def update_openjam_admin(
    jam_id: int,
    data: schemas.OpenJamAdminUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    jam = _jam_query(db).options(
        joinedload(models.OpenJam.leader)
    ).filter(models.OpenJam.id == jam_id).first()
    if not jam:
        raise HTTPException(404, "그런 오픈 잼이 없습니다.")
    if data.status:
        jam.status = data.status
    db.commit()
    db.refresh(jam)
    log_event("openjam_admin_updated", id=jam.id, status=jam.status, by=admin.username)
    audit(db, admin, "openjam.update", jam.title, f"상태 {jam.status}", request)
    return _admin_view(jam)


@router.delete("/api/admin/openjams/{jam_id}")
def delete_openjam_admin(
    jam_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    jam = get_or_404(db, models.OpenJam, jam_id, "그런 오픈 잼이 없습니다.")
    title = jam.title
    db.delete(jam)
    db.commit()
    log_event("openjam_admin_deleted", id=jam_id, title=title, by=admin.username)
    audit(db, admin, "openjam.delete", title, request=request)
    return {"message": "삭제되었습니다."}
