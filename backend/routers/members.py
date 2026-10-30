from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional

from database import get_db
from app_logging import log_event
from deps import (
    get_current_admin, normalize_phone, clean_parts, audit, get_or_404,
    set_member_teams,
)
import models
import schemas

router = APIRouter(prefix="/api/admin/members", tags=["members"])


def _member_response(m: models.Member) -> schemas.MemberResponse:
    out = schemas.MemberResponse.model_validate(m)
    # 소속 순서는 대표 팀(members.team_id) 이 먼저, 나머지는 이름순.
    refs = [
        schemas.MemberTeamRef(
            id=ms.team.id, name=ms.team.name,
            billing_type=ms.team.billing_type, dues_exempt=ms.dues_exempt,
        )
        for ms in m.memberships if ms.team is not None
    ]
    refs.sort(key=lambda t: (t.id != m.team_id, t.name))
    out.teams = refs
    out.team_name = refs[0].name if refs else None
    return out


def _member_query(db: Session):
    """목록·단건 모두 소속 팀을 바로 읽으므로 미리 조인해 온다 (N+1 방지)."""
    return db.query(models.Member).options(
        joinedload(models.Member.memberships).joinedload(models.MemberTeam.team)
    )


def _teams_from(data, fields=None) -> tuple:
    """team_ids 가 정본이고, team_id 만 온 옛 호출은 한 팀짜리 목록으로 본다.
    둘 다 없으면 (None, None) — 소속을 건드리지 말라는 뜻."""
    sent = fields if fields is not None else data.model_fields_set
    if 'team_ids' in sent:
        # team_exempt_ids 를 안 보냈으면 팀별 면제는 그대로 둔다 —
        # 팀 상세에서 소속만 추가할 때 면제 설정이 날아가지 않게.
        exempt = (data.team_exempt_ids or []) if 'team_exempt_ids' in sent else None
        return (data.team_ids or []), exempt
    if 'team_id' in sent:
        return ([data.team_id] if data.team_id is not None else []), None
    return None, None


@router.get("", response_model=List[schemas.MemberResponse])
def list_members(
    active: Optional[bool] = None,
    team_id: Optional[int] = None,
    doors: Optional[bool] = None,
    needs_check: Optional[bool] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    query = _member_query(db)
    if active is not None:
        query = query.filter(models.Member.is_active == active)
    if team_id is not None:
        # 대표 팀이 아니라 '이 팀에 속해 있는가' 로 본다.
        query = query.filter(models.Member.memberships.any(
            models.MemberTeam.team_id == team_id
        ))
    if doors is not None:
        query = query.filter(models.Member.is_doors == doors)
    if needs_check is not None:
        query = query.filter(models.Member.needs_check == needs_check)
    members = query.order_by(models.Member.is_active.desc(), models.Member.name).all()
    return [_member_response(m) for m in members]


@router.post("", response_model=schemas.MemberResponse)
def create_member(
    data: schemas.MemberCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    member = models.Member(
        is_doors=data.is_doors,
        name=data.name.strip(),
        phone=normalize_phone(data.phone),
        parts=clean_parts(data.parts),
        gender=data.gender,
        birth_year=data.birth_year,
        role=data.role,
        joined_on=data.joined_on,
        is_active=data.is_active,
        needs_check=data.needs_check,
        dues_exempt=data.dues_exempt,
        monthly_fee=data.monthly_fee,
        memo=(data.memo or '').strip() or None,
    )
    db.add(member)
    team_ids, exempt_ids = _teams_from(data)
    set_member_teams(db, member, team_ids or [], exempt_ids)
    db.commit()
    db.refresh(member)
    log_event("member_created", id=member.id, name=member.name,
              team_id=member.team_id, by=admin.username)
    out = _member_response(member)
    audit(db, admin, "member.create", member.name,
          "소속 " + (" · ".join(t.name for t in out.teams) or "무소속"), request)
    return out


@router.patch("/{member_id}", response_model=schemas.MemberResponse)
def update_member(
    member_id: int,
    data: schemas.MemberUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    member = _member_query(db).filter(models.Member.id == member_id).first()
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없습니다.")

    fields = data.model_dump(exclude_unset=True)
    if 'name' in fields and fields['name']:
        member.name = fields['name'].strip()
    if 'phone' in fields:
        member.phone = normalize_phone(fields['phone'])
    if 'parts' in fields:
        member.parts = clean_parts(fields['parts'])
    if 'memo' in fields:
        member.memo = (fields['memo'] or '').strip() or None
    team_ids, exempt_ids = _teams_from(data, fields)
    if team_ids is not None:
        set_member_teams(db, member, team_ids, exempt_ids)
    for field in ('gender', 'birth_year', 'role', 'joined_on', 'is_active',
                  'dues_exempt', 'monthly_fee', 'is_doors', 'needs_check'):
        if field in fields:
            setattr(member, field, fields[field])

    db.commit()
    db.refresh(member)
    log_event("member_updated", id=member.id, name=member.name,
              team_id=member.team_id, by=admin.username)
    audit(db, admin, "member.update", member.name,
          "바꾼 항목: " + (", ".join(fields) or "없음"), request)
    return _member_response(member)


@router.delete("/{member_id}")
def delete_member(
    member_id: int,
    request: Request,
    force: bool = False,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    member = get_or_404(db, models.Member, member_id, "멤버를 찾을 수 없습니다.")
    dues = db.query(models.MemberDues).filter(models.MemberDues.member_id == member_id).count()
    if dues and not force:
        # force=true is for mis-registered members — it drops their dues history too.
        raise HTTPException(
            400,
            f"회비 기록이 {dues}건 있어 삭제할 수 없습니다. 비활성 처리해주세요.",
        )
    name = member.name
    # 예약은 이름(booker_name)이 스냅샷으로 남는다 — 연결만 끊는다.
    db.query(models.Reservation).filter(models.Reservation.member_id == member_id) \
        .update({"member_id": None}, synchronize_session=False)
    db.delete(member)
    db.commit()
    log_event("member_deleted", id=member_id, name=name, by=admin.username)
    audit(db, admin, "member.delete", name,
          "회비 기록까지 삭제" if force else None, request)
    return {"message": "삭제되었습니다."}
