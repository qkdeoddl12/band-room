from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from datetime import date
from typing import List, Optional
import re

from database import get_db
from app_logging import log_event
from deps import get_current_admin, default_monthly_fee, resolve_member_fee, audit
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

    query = db.query(models.Member).filter(models.Member.is_active == True)
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

    return schemas.DuesMonthResponse(
        year_month=year_month,
        rows=rows,
        total_expected=total_expected,
        total_paid=total_paid,
        unpaid_count=unpaid,
        pending_count=pending,
        exempt_count=exempt,
        covered_count=covered,
    )


@router.get("/summary", response_model=List[schemas.DuesSummaryRow])
def get_dues_summary(
    year: int,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    if not (2000 <= year <= 2999):
        raise HTTPException(400, "연도가 올바르지 않습니다.")
    records = db.query(models.MemberDues).filter(
        models.MemberDues.year_month.like(f"{year}-%")
    ).all()

    paid_by_month = {}
    unpaid_by_month = {}
    for r in records:
        if r.status == 'paid':
            paid_by_month[r.year_month] = paid_by_month.get(r.year_month, 0) + r.amount
        elif r.status == 'unpaid':
            unpaid_by_month[r.year_month] = unpaid_by_month.get(r.year_month, 0) + 1

    return [
        schemas.DuesSummaryRow(
            year_month=f"{year}-{m:02d}",
            paid=paid_by_month.get(f"{year}-{m:02d}", 0),
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
    member = db.query(models.Member).filter(models.Member.id == member_id).first()
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없습니다.")

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
