from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import List

from database import get_db
from app_logging import log_event
from deps import get_current_admin, normalize_phone, clean_parts, audit
import models
import schemas

router = APIRouter(tags=["teams"])


def _team_response(t: models.Team, res_count: int = 0, member_count: int = 0) -> schemas.TeamResponse:
    return schemas.TeamResponse(
        id=t.id, name=t.name, leader_name=t.leader_name, phone=t.phone,
        parts=t.parts, memo=t.memo, billing_type=t.billing_type, monthly_fee=t.monthly_fee,
        dues_fee=t.dues_fee, is_active=t.is_active, created_at=t.created_at,
        reservation_count=res_count, member_count=member_count,
    )


def _apply_billing(team: models.Team, billing_type: str, monthly_fee, dues_fee):
    """과금 방식이 바뀌면 안 쓰는 금액은 비운다 — 나중에 되돌렸을 때
    예전 금액이 되살아나 잘못 청구되는 일을 막는다."""
    team.billing_type = billing_type
    team.monthly_fee = monthly_fee if billing_type == 'monthly' else None
    team.dues_fee = dues_fee if billing_type == 'dues' else None


@router.get("/api/teams", response_model=List[schemas.TeamPublic])
def list_public_teams(db: Session = Depends(get_db)):
    """예약 페이지 드롭다운용. 활성 팀 이름만 노출."""
    return db.query(models.Team).filter(
        models.Team.is_active == True
    ).order_by(models.Team.name).all()


@router.get("/api/admin/teams", response_model=List[schemas.TeamResponse])
def list_teams(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    teams = db.query(models.Team).order_by(models.Team.name).all()
    res_counts = dict(
        db.query(models.Reservation.team_id, func.count(models.Reservation.id))
        .filter(models.Reservation.team_id.isnot(None))
        .group_by(models.Reservation.team_id)
        .all()
    )
    member_counts = dict(
        db.query(models.Member.team_id, func.count(models.Member.id))
        .filter(models.Member.team_id.isnot(None), models.Member.is_active == True)
        .group_by(models.Member.team_id)
        .all()
    )
    return [
        _team_response(t, res_counts.get(t.id, 0), member_counts.get(t.id, 0))
        for t in teams
    ]


@router.post("/api/admin/teams", response_model=schemas.TeamResponse)
def create_team(
    data: schemas.TeamCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    name = data.name.strip()
    if db.query(models.Team).filter(models.Team.name == name).first():
        raise HTTPException(400, "이미 등록된 팀 이름입니다.")
    team = models.Team(
        name=name,
        leader_name=(data.leader_name or '').strip() or None,
        phone=normalize_phone(data.phone),
        parts=clean_parts(data.parts),
        memo=(data.memo or '').strip() or None,
        is_active=data.is_active,
    )
    _apply_billing(team, data.billing_type, data.monthly_fee, data.dues_fee)
    db.add(team)
    db.commit()
    db.refresh(team)
    log_event("team_created", id=team.id, name=team.name,
              billing=team.billing_type, by=admin.username)
    audit(db, admin, "team.create", team.name,
          f"과금 {team.billing_type}", request)
    return _team_response(team)


@router.patch("/api/admin/teams/{team_id}", response_model=schemas.TeamResponse)
def update_team(
    team_id: int,
    data: schemas.TeamUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    team = db.query(models.Team).filter(models.Team.id == team_id).first()
    if not team:
        raise HTTPException(404, "팀을 찾을 수 없습니다.")

    fields = data.model_dump(exclude_unset=True)

    if fields.get('name'):
        name = fields['name'].strip()
        dup = db.query(models.Team).filter(
            models.Team.name == name, models.Team.id != team_id
        ).first()
        if dup:
            raise HTTPException(400, "이미 등록된 팀 이름입니다.")
        team.name = name
    for field in ('leader_name', 'memo'):
        if field in fields:
            setattr(team, field, (fields[field] or '').strip() or None)
    if 'phone' in fields:
        team.phone = normalize_phone(fields['phone'])
    if 'parts' in fields:
        team.parts = clean_parts(fields['parts'])
    if fields.get('is_active') is not None:
        team.is_active = fields['is_active']

    if 'billing_type' in fields and fields['billing_type']:
        _apply_billing(
            team, fields['billing_type'],
            fields.get('monthly_fee', team.monthly_fee),
            fields.get('dues_fee', team.dues_fee),
        )
    else:
        if 'monthly_fee' in fields and team.billing_type == 'monthly':
            team.monthly_fee = fields['monthly_fee']
        if 'dues_fee' in fields and team.billing_type == 'dues':
            team.dues_fee = fields['dues_fee']

    db.commit()
    db.refresh(team)
    log_event("team_updated", id=team.id, name=team.name,
              billing=team.billing_type, by=admin.username)
    audit(db, admin, "team.update", team.name,
          "바꾼 항목: " + (", ".join(fields) or "없음"), request)
    res_count = db.query(models.Reservation).filter(models.Reservation.team_id == team.id).count()
    member_count = db.query(models.Member).filter(
        models.Member.team_id == team.id, models.Member.is_active == True
    ).count()
    return _team_response(team, res_count, member_count)


@router.delete("/api/admin/teams/{team_id}")
def delete_team(
    team_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    team = db.query(models.Team).filter(models.Team.id == team_id).first()
    if not team:
        raise HTTPException(404, "팀을 찾을 수 없습니다.")
    used = db.query(models.Reservation).filter(models.Reservation.team_id == team_id).count()
    if used:
        raise HTTPException(
            400,
            f"예약 이력이 {used}건 있어 삭제할 수 없습니다. 비활성 처리해주세요.",
        )
    members = db.query(models.Member).filter(models.Member.team_id == team_id).count()
    if members:
        raise HTTPException(
            400,
            f"소속 멤버가 {members}명 있어 삭제할 수 없습니다. 멤버를 먼저 옮겨주세요.",
        )
    name = team.name
    db.delete(team)
    db.commit()
    log_event("team_deleted", id=team_id, name=name, by=admin.username)
    audit(db, admin, "team.delete", name, request=request)
    return {"message": "삭제되었습니다."}
