from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from datetime import date
from typing import List, Optional
import re

from database import get_db
from app_logging import log_event
from deps import (
    get_current_admin, default_monthly_fee, resolve_member_fee, audit, get_or_404,
)
import models
import schemas

router = APIRouter(prefix="/api/admin/dues", tags=["dues"])

YEAR_MONTH_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')


def _check_year_month(year_month: str) -> str:
    if not YEAR_MONTH_RE.match(year_month):
        raise HTTPException(400, "년월 형식은 YYYY-MM 이어야 합니다.")
    return year_month


@router.get("", response_model=schemas.DuesMonthResponse)
def get_dues_month(
    year_month: str,
    team_id: Optional[int] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """활성 멤버를 반환한다. 해당 월 기록이 없는 멤버는 기본 상태로 채워 보낸다
    (조회만으로 DB row를 만들지 않는다 — 생성은 PUT upsert에서만).
    team_id 를 주면 그 팀 소속만 추린다."""
    _check_year_month(year_month)
    fallback = default_monthly_fee(db)

    # m.team 을 행마다 건드리므로 미리 조인해 온다 (N+1 방지).
    query = db.query(models.Member).options(
        joinedload(models.Member.team)
    ).filter(models.Member.is_active == True)
    if team_id is not None:
        query = query.filter(models.Member.team_id == team_id)
    members = query.order_by(models.Member.name).all()
    existing = {
        d.member_id: d
        for d in db.query(models.MemberDues).filter(
            models.MemberDues.year_month == year_month
        ).all()
    }

    rows: List[schemas.DuesRow] = []
    total_expected = total_paid = 0
    unpaid = pending = exempt = covered = 0

    for m in members:
        fee = resolve_member_fee(m, m.team, fallback)
        rec = existing.get(m.id)
        if rec:
            status, amount = rec.status, rec.amount
            paid_on, memo = rec.paid_on, rec.memo
        else:
            status = 'exempt' if m.dues_exempt else 'unpaid'
            amount, paid_on, memo = 0, None, None

        # 팀이 월 이용료를 통째로 내는 경우 이 사람은 개인 회비 대상이 아니다.
        # (도어즈 멤버십은 그대로 유지된다 — 명부에는 계속 남는다)
        covered_by_team = m.team is not None and m.team.billing_type == 'monthly'
        if covered_by_team:
            covered += 1
        elif status != 'exempt':
            total_expected += fee

        if covered_by_team:
            pass
        elif status == 'paid':
            total_paid += amount
        elif status == 'unpaid':
            unpaid += 1
        elif status == 'pending':
            pending += 1
        else:
            exempt += 1

        rows.append(schemas.DuesRow(
            member_id=m.id, team_id=m.team_id,
            team_name=m.team.name if m.team else None,
            covered_by_team=covered_by_team,
            name=m.name, parts=m.parts, dues_exempt=m.dues_exempt,
            fee=fee, status=status, amount=amount, paid_on=paid_on, memo=memo,
        ))

    team_rows, team_expected, team_paid = _team_rows(db, year_month, team_id)

    return schemas.DuesMonthResponse(
        year_month=year_month,
        rows=rows,
        total_expected=total_expected,
        total_paid=total_paid,
        unpaid_count=unpaid,
        pending_count=pending,
        exempt_count=exempt,
        covered_count=covered,
        team_rows=team_rows,
        team_total_expected=team_expected,
        team_total_paid=team_paid,
    )


def _team_rows(db: Session, year_month: str, team_id=None):
    """월 이용료 팀의 그 달 납부 현황. 기록이 없으면 미납으로 채워 보낸다
    (멤버 쪽과 같은 규칙 — 조회만으로 row 를 만들지 않는다)."""
    query = db.query(models.Team).filter(
        models.Team.is_active == True,
        models.Team.billing_type == 'monthly',
    )
    if team_id is not None:
        query = query.filter(models.Team.id == team_id)
    teams = query.order_by(models.Team.name).all()
    if not teams:
        return [], 0, 0

    existing = {
        d.team_id: d
        for d in db.query(models.TeamDues).filter(
            models.TeamDues.year_month == year_month,
            models.TeamDues.team_id.in_([t.id for t in teams]),
        ).all()
    }
    counts = dict(
        db.query(models.Member.team_id, func.count(models.Member.id))
        .filter(models.Member.is_active == True,
                models.Member.team_id.in_([t.id for t in teams]))
        .group_by(models.Member.team_id).all()
    )

    rows, expected, paid = [], 0, 0
    for team in teams:
        fee = team.monthly_fee or 0
        rec = existing.get(team.id)
        status = rec.status if rec else 'unpaid'
        if status != 'exempt':
            expected += fee
        if status == 'paid':
            paid += rec.amount
        rows.append(schemas.TeamDuesRow(
            team_id=team.id, name=team.name,
            member_count=counts.get(team.id, 0), fee=fee,
            status=status,
            amount=rec.amount if rec else 0,
            paid_on=rec.paid_on if rec else None,
            memo=rec.memo if rec else None,
        ))
    return rows, expected, paid


@router.get("/history/member/{member_id}", response_model=List[schemas.DuesHistoryRow])
def member_dues_history(
    member_id: int,
    months: int = 12,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    get_or_404(db, models.Member, member_id, "멤버를 찾을 수 없습니다.")
    return _history(db.query(models.MemberDues).filter(
        models.MemberDues.member_id == member_id
    ).order_by(models.MemberDues.year_month.desc()), months)


@router.get("/history/team/{team_id}", response_model=List[schemas.DuesHistoryRow])
def team_dues_history(
    team_id: int,
    months: int = 12,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")
    return _history(db.query(models.TeamDues).filter(
        models.TeamDues.team_id == team_id
    ).order_by(models.TeamDues.year_month.desc()), months)


def _history(query, months: int):
    """기록이 있는 달만 최근 순으로. 없는 달은 아무 일도 없었던 달이다."""
    records = query.limit(max(1, min(months, 60))).all()
    return [
        schemas.DuesHistoryRow(
            year_month=r.year_month, status=r.status, amount=r.amount,
            paid_on=r.paid_on, memo=r.memo,
        )
        for r in records
    ]


# 아래 PUT /{member_id}/{year_month} 보다 먼저 선언해야 'team' 이
# member_id 로 해석되지 않는다.
@router.put("/team/{team_id}/{year_month}", response_model=schemas.TeamDuesRow)
def upsert_team_dues(
    team_id: int,
    year_month: str,
    data: schemas.DuesUpsert,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    _check_year_month(year_month)
    team = get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")
    if team.billing_type != 'monthly':
        raise HTTPException(400, "월 이용료 팀만 팀 단위로 입금 기록을 남깁니다.")

    fee = team.monthly_fee or 0
    rec = db.query(models.TeamDues).filter(
        models.TeamDues.team_id == team_id,
        models.TeamDues.year_month == year_month,
    ).first()
    if not rec:
        rec = models.TeamDues(team_id=team_id, year_month=year_month)
        db.add(rec)

    rec.status = data.status
    if data.status == 'paid':
        rec.amount = data.amount if data.amount is not None else fee
        rec.paid_on = data.paid_on or date.today()
    else:
        rec.amount = data.amount or 0
        rec.paid_on = data.paid_on
    rec.memo = (data.memo or '').strip() or None

    db.commit()
    db.refresh(rec)
    log_event(
        "team_dues_updated",
        team_id=team_id, team=team.name, month=year_month,
        status=rec.status, amount=rec.amount, by=admin.username,
    )
    audit(db, admin, "dues.team_update", f"{team.name} {year_month}",
          f"{rec.status} {rec.amount:,}원", request)
    return schemas.TeamDuesRow(
        team_id=team.id, name=team.name, fee=fee,
        status=rec.status, amount=rec.amount,
        paid_on=rec.paid_on, memo=rec.memo,
    )


@router.get("/summary", response_model=List[schemas.DuesSummaryRow])
def get_dues_summary(
    year: int,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    if not (2000 <= year <= 2999):
        raise HTTPException(400, "연도가 올바르지 않습니다.")
    like = f"{year}-%"
    paid_by_month = {}
    team_by_month = {}
    unpaid_by_month = {}
    # 멤버 회비와 팀 월 이용료는 성격이 다른 수입이라 따로 센다.
    for r in db.query(models.MemberDues).filter(
        models.MemberDues.year_month.like(like)
    ).all():
        if r.status == 'paid':
            paid_by_month[r.year_month] = paid_by_month.get(r.year_month, 0) + r.amount
        elif r.status == 'unpaid':
            unpaid_by_month[r.year_month] = unpaid_by_month.get(r.year_month, 0) + 1
    for r in db.query(models.TeamDues).filter(
        models.TeamDues.year_month.like(like), models.TeamDues.status == 'paid'
    ).all():
        team_by_month[r.year_month] = team_by_month.get(r.year_month, 0) + r.amount

    return [
        schemas.DuesSummaryRow(
            year_month=f"{year}-{m:02d}",
            paid=paid_by_month.get(f"{year}-{m:02d}", 0),
            team_paid=team_by_month.get(f"{year}-{m:02d}", 0),
            unpaid_count=unpaid_by_month.get(f"{year}-{m:02d}", 0),
        )
        for m in range(1, 13)
    ]


@router.put("/{member_id}/{year_month}", response_model=schemas.DuesRow)
def upsert_dues(
    member_id: int,
    year_month: str,
    data: schemas.DuesUpsert,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    _check_year_month(year_month)
    member = get_or_404(db, models.Member, member_id, "멤버를 찾을 수 없습니다.")

    fee = resolve_member_fee(member, member.team, default_monthly_fee(db))
    rec = db.query(models.MemberDues).filter(
        models.MemberDues.member_id == member_id,
        models.MemberDues.year_month == year_month,
    ).first()
    if not rec:
        rec = models.MemberDues(member_id=member_id, year_month=year_month)
        db.add(rec)

    rec.status = data.status
    if data.status == 'paid':
        rec.amount = data.amount if data.amount is not None else fee
        rec.paid_on = data.paid_on or date.today()
    else:
        rec.amount = data.amount or 0
        rec.paid_on = data.paid_on
    rec.memo = (data.memo or '').strip() or None

    db.commit()
    db.refresh(rec)
    log_event(
        "dues_updated",
        member_id=member_id,
        member=member.name,
        month=year_month,
        status=rec.status,
        amount=rec.amount,
        by=admin.username,
    )
    audit(db, admin, "dues.update", f"{member.name} {year_month}",
          f"{rec.status} {rec.amount:,}원", request)
    return schemas.DuesRow(
        member_id=member.id, team_id=member.team_id,
        team_name=member.team.name if member.team else None,
        name=member.name, parts=member.parts,
        dues_exempt=member.dues_exempt, fee=fee,
        status=rec.status, amount=rec.amount, paid_on=rec.paid_on, memo=rec.memo,
    )
