from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from datetime import date
from typing import List, Optional
import re

from database import get_db
from app_logging import log_event
from deps import (
    get_current_admin, default_monthly_fee, default_team_fee,
    resolve_member_fee, audit, get_or_404,
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
    """활성 **도어즈** 멤버의 그 달 회비를 소속 팀마다 한 건씩 반환한다 — 밴드를 두 개
    하면 회비도 두 건이다. 무소속이면 팀 없는 한 건. 기록이 없는 달은 기본 상태로 채워
    보낸다 (조회만으로 DB row를 만들지 않는다 — 생성은 PUT upsert에서만).
    team_id 를 주면 그 팀 소속 건만 추린다.

    월회비는 도어즈 회비다. 도어즈가 아닌 사람은 낼 것이 없어 목록에 있어봐야
    '팀 납부' 뱃지만 달고 자리를 차지한다 — 아예 빼서 확인할 줄만 남긴다."""
    _check_year_month(year_month)
    fallback = default_monthly_fee(db)

    # 소속 팀을 행마다 건드리므로 미리 조인해 온다 (N+1 방지).
    query = db.query(models.Member).options(
        joinedload(models.Member.memberships).joinedload(models.MemberTeam.team)
    ).filter(models.Member.is_active == True, models.Member.is_doors == True)
    if team_id is not None:
        query = query.filter(models.Member.memberships.any(
            models.MemberTeam.team_id == team_id
        ))
    members = query.order_by(models.Member.name).all()
    # 키가 (멤버, 팀) 이다. 팀이 다르면 같은 사람이라도 다른 회비다.
    existing = {
        (d.member_id, d.team_id): d
        for d in db.query(models.MemberDues).filter(
            models.MemberDues.year_month == year_month
        ).all()
    }

    rows: List[schemas.DuesRow] = []
    total_expected = total_paid = 0
    unpaid = pending = exempt = covered = 0

    for m in members:
        mine = [ms for ms in m.memberships
                if team_id is None or ms.team_id == team_id]
        mine.sort(key=lambda ms: ms.team.name if ms.team else '')
        if not mine and team_id is not None:
            continue

        for ms in (mine or [None]):
            team = ms.team if ms else None
            fee = resolve_member_fee(m, team, fallback)
            rec = existing.pop((m.id, team.id if team else None), None)
            if rec:
                status, amount = rec.status, rec.amount
                paid_on, memo = rec.paid_on, rec.memo
            else:
                # 멤버 전체 면제 · 이 팀만 면제 · 운영진/모임장 — 셋 다 기본값이 면제다.
                # (그 달 기록을 남기면 위 rec 분기가 이겨서 수동 지정이 우선한다)
                off = (m.dues_exempt or m.role in ('staff', 'leader')
                       or (ms.dues_exempt if ms else False))
                status = 'exempt' if off else 'unpaid'
                amount, paid_on, memo = 0, None, None

            # 그 팀이 월 이용료를 통째로 내면 이 건은 개인이 낼 것이 없다.
            # (도어즈 멤버십은 그대로 유지된다 — 명부에는 계속 남는다)
            covered_by_team = team is not None and team.billing_type == 'monthly'
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
                member_id=m.id,
                team_id=team.id if team else None,
                team_name=team.name if team else None,
                covered_by_team=covered_by_team,
                name=m.name, parts=m.parts, role=m.role, dues_exempt=m.dues_exempt,
                fee=fee, status=status, amount=amount, paid_on=paid_on, memo=memo,
            ))

    team_rows, team_expected, team_paid = _team_rows(db, year_month, team_id)
    if team_id is None:
        # 그 뒤 비활성·탈퇴·과금 변경으로 행이 사라진 기록도 낸 돈이다 —
        # 연간 합계(/summary)는 기록을 그대로 더하므로 여기도 같이 세야 숫자가 맞는다.
        total_paid += sum(d.amount for d in existing.values() if d.status == 'paid')
        shown = [t.team_id for t in team_rows]
        team_paid += sum(d.amount for d in db.query(models.TeamDues).filter(
            models.TeamDues.year_month == year_month,
            models.TeamDues.status == 'paid',
            models.TeamDues.team_id.notin_(shown),
        ).all())
    walk_total, walk_people, walk_meetups = _walk_in_totals(db, year_month)

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
        walk_in_total=walk_total,
        walk_in_count=walk_people,
        walk_in_meetups=walk_meetups,
    )


def _walk_in_totals(db: Session, year_month: str):
    """그 달 정모의 당일 참가비. 월회비·팀 이용료와 **합치지 않는다** —
    성격이 다른 수입이라 화면에서도 계열을 나눠 센다.
    참가비는 정모(예약) 날짜 기준이다 — 기록을 언제 적었는지와 무관해야 한다."""
    rows = db.query(
        models.MeetupAttendee.fee, models.MeetupRecord.id
    ).join(
        models.MeetupRecord, models.MeetupRecord.id == models.MeetupAttendee.record_id
    ).join(
        models.Reservation, models.Reservation.id == models.MeetupRecord.reservation_id
    ).filter(
        models.MeetupAttendee.pay_type == 'walk_in',
        func.to_char(models.Reservation.date, 'YYYY-MM') == year_month,
    ).all()
    return sum(r[0] for r in rows), len(rows), len({r[1] for r in rows})


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
        db.query(models.MemberTeam.team_id, func.count(models.MemberTeam.member_id))
        .join(models.Member, models.Member.id == models.MemberTeam.member_id)
        .filter(models.Member.is_active == True,
                models.MemberTeam.team_id.in_([t.id for t in teams]))
        .group_by(models.MemberTeam.team_id).all()
    )

    fallback = default_team_fee(db)
    rows, expected, paid = [], 0, 0
    for team in teams:
        # 금액을 안 적은 팀은 환경 설정의 기본 팀 이용료를 쓴다 (멤버 회비와 같은 규칙).
        fee = team.monthly_fee if team.monthly_fee is not None else fallback
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
    # 소속이 여럿이면 같은 달이 팀 수만큼 나오므로 어느 팀 몫인지 함께 보낸다.
    return _history(db.query(models.MemberDues).options(
        joinedload(models.MemberDues.team)
    ).filter(
        models.MemberDues.member_id == member_id
    ).order_by(models.MemberDues.year_month.desc()), months, with_team=True)


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


def _history(query, months: int, with_team: bool = False):
    """기록이 있는 달만 최근 순으로. 없는 달은 아무 일도 없었던 달이다."""
    records = query.limit(max(1, min(months, 60))).all()
    return [
        schemas.DuesHistoryRow(
            year_month=r.year_month, status=r.status, amount=r.amount,
            team_name=(r.team.name if with_team and r.team else None),
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

    fee = team.monthly_fee if team.monthly_fee is not None else default_team_fee(db)
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
    walk_by_month = {}
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
    # 정모 당일 참가비 — 세 번째 계열. 정모 날짜 기준으로 센다.
    for fee, ym in db.query(
        models.MeetupAttendee.fee,
        func.to_char(models.Reservation.date, 'YYYY-MM'),
    ).join(
        models.MeetupRecord, models.MeetupRecord.id == models.MeetupAttendee.record_id
    ).join(
        models.Reservation, models.Reservation.id == models.MeetupRecord.reservation_id
    ).filter(
        models.MeetupAttendee.pay_type == 'walk_in',
        func.to_char(models.Reservation.date, 'YYYY-MM').like(like),
    ).all():
        walk_by_month[ym] = walk_by_month.get(ym, 0) + fee

    return [
        schemas.DuesSummaryRow(
            year_month=f"{year}-{m:02d}",
            paid=paid_by_month.get(f"{year}-{m:02d}", 0),
            team_paid=team_by_month.get(f"{year}-{m:02d}", 0),
            walk_in_paid=walk_by_month.get(f"{year}-{m:02d}", 0),
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
    team_id: Optional[int] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """team_id 는 어느 소속 몫인지. 생략하면 무소속일 때의 회비 한 건이다."""
    _check_year_month(year_month)
    member = get_or_404(db, models.Member, member_id, "멤버를 찾을 수 없습니다.")

    team = None
    if team_id is not None:
        ms = next((x for x in member.memberships if x.team_id == team_id), None)
        if ms is None:
            raise HTTPException(400, "이 멤버의 소속 팀이 아닙니다.")
        team = ms.team

    fee = resolve_member_fee(member, team, default_monthly_fee(db))
    # 무소속 건은 team_id 가 NULL 이라 == 로는 안 잡힌다.
    same_team = (models.MemberDues.team_id == team_id) if team_id is not None \
        else models.MemberDues.team_id.is_(None)
    rec = db.query(models.MemberDues).filter(
        models.MemberDues.member_id == member_id,
        models.MemberDues.year_month == year_month,
        same_team,
    ).first()
    if not rec:
        rec = models.MemberDues(member_id=member_id, team_id=team_id,
                                year_month=year_month)
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
        team=(team.name if team else None),
        month=year_month,
        status=rec.status,
        amount=rec.amount,
        by=admin.username,
    )
    audit(db, admin, "dues.update",
          f"{member.name}{f'({team.name})' if team else ''} {year_month}",
          f"{rec.status} {rec.amount:,}원", request)
    return schemas.DuesRow(
        member_id=member.id,
        team_id=team.id if team else None,
        team_name=team.name if team else None,
        covered_by_team=(team is not None and team.billing_type == 'monthly'),
        name=member.name, parts=member.parts, role=member.role,
        dues_exempt=member.dues_exempt, fee=fee,
        status=rec.status, amount=rec.amount, paid_on=rec.paid_on, memo=rec.memo,
    )
