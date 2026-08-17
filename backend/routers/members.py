from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional

from database import get_db
from app_logging import log_event
from deps import get_current_admin, normalize_phone
import models
import schemas

router = APIRouter(prefix="/api/admin/members", tags=["members"])


def _clean_parts(parts: Optional[str]) -> Optional[str]:
    if not parts:
        return None
    items = [p.strip() for p in parts.split(',') if p.strip()]
    return ','.join(dict.fromkeys(items)) or None


def _member_response(m: models.Member) -> schemas.MemberResponse:
    out = schemas.MemberResponse.model_validate(m)
    out.team_name = m.team.name if m.team else None
    return out


@router.get("", response_model=List[schemas.MemberResponse])
def list_members(
    active: Optional[bool] = None,
    team_id: Optional[int] = None,
    doors: Optional[bool] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(models.Member)
    if active is not None:
        query = query.filter(models.Member.is_active == active)
    if team_id is not None:
        query = query.filter(models.Member.team_id == team_id)
    if doors is not None:
        query = query.filter(models.Member.is_doors == doors)
    members = query.order_by(models.Member.is_active.desc(), models.Member.name).all()
    return [_member_response(m) for m in members]


@router.post("", response_model=schemas.MemberResponse)
def create_member(
    data: schemas.MemberCreate,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    if data.team_id is not None and not db.query(models.Team).filter(
        models.Team.id == data.team_id
    ).first():
        raise HTTPException(400, "존재하지 않는 팀입니다.")

    member = models.Member(
        team_id=data.team_id,
        is_doors=data.is_doors,
        name=data.name.strip(),
        phone=normalize_phone(data.phone),
        parts=_clean_parts(data.parts),
        gender=data.gender,
        birth_year=data.birth_year,
        joined_on=data.joined_on,
        is_active=data.is_active,
        dues_exempt=data.dues_exempt,
        monthly_fee=data.monthly_fee,
        memo=(data.memo or '').strip() or None,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    log_event("member_created", id=member.id, name=member.name,
              team_id=member.team_id, by=admin.username)
    return _member_response(member)


@router.patch("/{member_id}", response_model=schemas.MemberResponse)
def update_member(
    member_id: int,
    data: schemas.MemberUpdate,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    member = db.query(models.Member).filter(models.Member.id == member_id).first()
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없습니다.")

    fields = data.model_dump(exclude_unset=True)
    if 'name' in fields and fields['name']:
        member.name = fields['name'].strip()
    if 'phone' in fields:
        member.phone = normalize_phone(fields['phone'])
    if 'parts' in fields:
        member.parts = _clean_parts(fields['parts'])
    if 'memo' in fields:
        member.memo = (fields['memo'] or '').strip() or None
    if 'team_id' in fields:
        if fields['team_id'] is not None and not db.query(models.Team).filter(
            models.Team.id == fields['team_id']
        ).first():
            raise HTTPException(400, "존재하지 않는 팀입니다.")
        member.team_id = fields['team_id']
    for field in ('gender', 'birth_year', 'joined_on', 'is_active',
                  'dues_exempt', 'monthly_fee', 'is_doors'):
        if field in fields:
            setattr(member, field, fields[field])

    db.commit()
    db.refresh(member)
    log_event("member_updated", id=member.id, name=member.name,
              team_id=member.team_id, by=admin.username)
    return _member_response(member)


@router.delete("/{member_id}")
def delete_member(
    member_id: int,
    force: bool = False,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    member = db.query(models.Member).filter(models.Member.id == member_id).first()
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없습니다.")
    dues = db.query(models.MemberDues).filter(models.MemberDues.member_id == member_id).count()
    if dues and not force:
        # force=true is for mis-registered members — it drops their dues history too.
        raise HTTPException(
            400,
            f"회비 기록이 {dues}건 있어 삭제할 수 없습니다. 비활성 처리해주세요.",
        )
    name = member.name
    db.delete(member)
    db.commit()
    log_event("member_deleted", id=member_id, name=name, by=admin.username)
    return {"message": "삭제되었습니다."}
