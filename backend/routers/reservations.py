from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import date, datetime, time, timedelta
from typing import List, Optional
import asyncio
import logging
import secrets

from database import get_db
from broadcaster import broadcaster
from app_logging import log_event
from deps import (
    get_current_admin, normalize_phone, member_dues_ok, audit, get_or_404,
)
import models
import schemas

router = APIRouter(tags=["reservations"])


# 24시간 운영이라 자정에 끝나는 예약(23:00~24:00)이 정상이다.
# 종료 시각 00:00 은 '다음날 0시'가 아니라 '그날 24시'를 뜻하므로
# 비교할 때만 1440분으로 바꿔 쓴다. 시작 시각에는 이 규칙을 적용하지 않는다.
DAY_MINUTES = 24 * 60


def _mins(t) -> int:
    return t.hour * 60 + t.minute


def _end_mins(t) -> int:
    m = _mins(t)
    return DAY_MINUTES if m == 0 else m


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    """[a_start, a_end) 와 [b_start, b_end) 가 겹치는지. 모두 분 단위."""
    return not (a_end <= b_start or a_start >= b_end)


def _split_by_day(start_dt: datetime, end_dt: datetime):
    """자정을 넘기는 구간을 날짜별로 쪼갠다.
    23:00~다음날 02:00 -> [(그날, 23:00, 00:00, 1h), (다음날, 00:00, 02:00, 2h)]
    종료가 자정 정각이면 쪼개지 않는다 (그날 24시로 본다)."""
    segments = []
    cursor = start_dt
    while cursor < end_dt:
        midnight = datetime.combine(cursor.date(), time(0, 0)) + timedelta(days=1)
        seg_end = min(end_dt, midnight)
        segments.append({
            "date": cursor.date(),
            "start": cursor.time(),
            "end": seg_end.time(),          # 자정이면 00:00 = 그날 24시
            "hours": int((seg_end - cursor).total_seconds() // 3600),
        })
        cursor = seg_end
    return segments


def _group_rows(db: Session, res: models.Reservation):
    """자정을 넘겨 나뉜 예약이면 짝을 모두, 아니면 자기 자신만."""
    if not res.group_key:
        return [res]
    return db.query(models.Reservation).filter(
        models.Reservation.group_key == res.group_key
    ).order_by(models.Reservation.date, models.Reservation.start_time).all()


def _sse_payload(r: models.Reservation) -> dict:
    """SSE 로 내보내는 예약 요약. 세 곳에서 같은 모양을 만들던 것을 모았다."""
    return {
        "id": r.id,
        "room_id": r.room_id,
        "date": str(r.date),
        "start_time": str(r.start_time),
        "end_time": str(r.end_time),
        "team_name": r.team_name,
        "status": r.status,
    }


@router.get("/api/rooms", response_model=List[schemas.Room])
def get_rooms(db: Session = Depends(get_db)):
    return db.query(models.Room).order_by(models.Room.id).all()


@router.get("/api/reservations", response_model=List[schemas.ReservationResponse])
def get_reservations(
    date: Optional[str] = None,
    room_id: Optional[int] = None,
    team_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Reservation)
    if date:
        query = query.filter(models.Reservation.date == date)
    if room_id:
        query = query.filter(models.Reservation.room_id == room_id)
    if team_id:
        query = query.filter(models.Reservation.team_id == team_id)
    return query.order_by(models.Reservation.date, models.Reservation.start_time).all()


@router.get("/api/reservations/stream")
async def reservations_stream(request: Request):
    queue = await broadcaster.subscribe()

    async def event_gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield {"data": msg}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            await broadcaster.unsubscribe(queue)

    return EventSourceResponse(event_gen())


def find_member_by_name(db: Session, name: str):
    """이름으로 활동 중인 멤버를 찾는다.
    반환: (member, ambiguous). 동명이인이면 (None, True) — 잘못된 사람에게
    무료 이용을 붙이는 것보다 막고 관리자가 정리하는 편이 안전하다."""
    cleaned = (name or '').strip()
    if not cleaned:
        return None, False
    matches = db.query(models.Member).filter(
        models.Member.name == cleaned,
        models.Member.is_active == True,
    ).all()
    if len(matches) == 1:
        return matches[0], False
    if len(matches) > 1:
        return None, True
    return None, False


@router.post("/api/members/check", response_model=schemas.MemberCheckResponse)
def check_member(data: schemas.MemberCheckRequest, db: Session = Depends(get_db)):
    """예약 페이지에서 이름을 입력했을 때 요금이 어떻게 되는지 미리 알려준다."""
    member, ambiguous = find_member_by_name(db, data.name)
    if ambiguous:
        return schemas.MemberCheckResponse(
            ambiguous=True,
            message="같은 이름의 멤버가 여러 명입니다. 문의하기로 접수해주세요.",
        )
    if not member:
        return schemas.MemberCheckResponse(message="게스트로 예약됩니다. 시간당 요금이 적용됩니다.")

    # 예약하려는 달의 회비를 본다 — 예약 생성 때와 같은 기준이어야 한다.
    ym = (data.date or date.today()).strftime('%Y-%m')
    ok = member_dues_ok(db, member, ym)
    return schemas.MemberCheckResponse(
        is_member=True,
        dues_ok=ok,
        message="회비 납부가 확인되었습니다. 무료로 이용하실 수 있습니다."
        if ok else "이번 달 회비가 확인되지 않아 시간당 요금이 적용됩니다.",
    )


@router.post("/api/reservations", response_model=schemas.ReservationResponse)
def create_reservation(
    reservation: schemas.ReservationCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    room = db.query(models.Room).filter(models.Room.id == reservation.room_id).first()
    if not room:
        raise HTTPException(400, "존재하지 않는 공간입니다.")

    team = None
    member = None
    booker_name = None
    booker_phone = None
    free = False   # 요금 없이 바로 확정할지

    if room.booking_mode == 'personal':
        # 개인연습실 — 팀이 아니라 멤버 본인이나 게스트가 쓴다.
        booker_name = (reservation.booker_name or '').strip()
        if not booker_name:
            raise HTTPException(400, "이용자 이름을 입력해주세요.")

        member, ambiguous = find_member_by_name(db, booker_name)
        if ambiguous:
            raise HTTPException(400, "같은 이름의 멤버가 여러 명입니다. 문의하기로 접수해주세요.")

        booker_phone = normalize_phone(reservation.booker_phone)
        if member:
            free = member_dues_ok(db, member, reservation.date.strftime('%Y-%m'))
        elif not booker_phone:
            # 게스트는 연락이 닿아야 입금 확인을 할 수 있다.
            raise HTTPException(400, "게스트 예약은 연락처가 필요합니다.")
    else:
        team = db.query(models.Team).filter(models.Team.id == reservation.team_id).first()
        if not team or not team.is_active:
            raise HTTPException(400, "등록되지 않은 팀입니다. 문의하기로 팀 등록을 요청해주세요.")
        free = not team.is_hourly

    start_dt = datetime.combine(reservation.date, reservation.start_time)
    end_dt = start_dt + timedelta(hours=reservation.duration)
    # 자정을 넘기면 거부하지 않고 날짜별로 쪼갠다 (23시~새벽 2시 같은 예약).
    segments = _split_by_day(start_dt, end_dt)
    if len(segments) > 2:
        raise HTTPException(400, "예약은 하루를 넘겨 이틀까지만 가능합니다.")

    # 나뉜 구간을 각각 검사한다 — 한 구간이라도 막히면 전체를 거부한다.
    for seg in segments:
        seg_start, seg_end = _mins(seg["start"]), _end_mins(seg["end"])

        for r in db.query(models.Reservation).filter(
            models.Reservation.room_id == reservation.room_id,
            models.Reservation.date == seg["date"],
        ).all():
            if _overlaps(seg_start, seg_end, _mins(r.start_time), _end_mins(r.end_time)):
                log_event(
                    "reservation_conflict",
                    level=logging.WARNING,
                    client=request.client.host if request.client else None,
                    room_id=reservation.room_id,
                    date=str(seg["date"]),
                    start=str(seg["start"]),
                    end=str(seg["end"]),
                    team=team.name if team else booker_name,
                )
                raise HTTPException(400, "해당 시간에 이미 예약이 있습니다.")

        for b in db.query(models.BlockedPeriod).filter(
            models.BlockedPeriod.date == seg["date"],
        ).all():
            if b.room_id is not None and b.room_id != reservation.room_id:
                continue
            if b.start_time is None or b.end_time is None:
                overlaps = True
            else:
                overlaps = _overlaps(seg_start, seg_end, _mins(b.start_time), _end_mins(b.end_time))
            if overlaps:
                log_event(
                    "reservation_blocked",
                    level=logging.WARNING,
                    client=request.client.host if request.client else None,
                    room_id=reservation.room_id,
                    date=str(seg["date"]),
                    start=str(seg["start"]),
                    end=str(seg["end"]),
                    blocked_id=b.id,
                    reason=b.reason,
                )
                msg = "해당 시간은 예약이 차단되어 있습니다."
                if b.reason:
                    msg += f" ({b.reason})"
                raise HTTPException(400, msg)

    # 나뉜 예약도 사용자에겐 한 건이다 — group_key 로 묶어 함께 확정·취소한다.
    group_key = secrets.token_hex(8) if len(segments) > 1 else None
    created = []
    for seg in segments:
        row = models.Reservation(
            room_id=reservation.room_id,
            team_id=team.id if team else None,
            member_id=member.id if member else None,
            booker_name=booker_name,
            booker_phone=booker_phone,
            date=seg["date"],
            start_time=seg["start"],
            end_time=seg["end"],
            duration=seg["hours"],
            team_name=team.name if team else booker_name,
            members=reservation.members,
            note=reservation.note,
            # 낼 것이 없는 예약(선불 팀 · 회비 낸 멤버)은 입금 확인 단계를 건너뛴다.
            is_free=free,
            status='confirmed' if free else 'pending',
            group_key=group_key,
        )
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
        broadcaster.publish("reservation_created", _sse_payload(row))

    db_r = created[0]
    log_event(
        "reservation_created",
        id=db_r.id,
        room_id=db_r.room_id,
        date=str(db_r.date),
        start=str(db_r.start_time),
        end=str(created[-1].end_time),
        team=db_r.team_name,
        member_id=db_r.member_id,
        segments=len(created),
        status=db_r.status,
        client=request.client.host if request.client else None,
    )
    return db_r


@router.post("/api/reservations/{reservation_id}/confirm", response_model=schemas.ReservationResponse)
def confirm_reservation(
    reservation_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    if res.status == 'confirmed':
        raise HTTPException(400, "이미 확정된 예약입니다.")

    rows = _group_rows(db, res)
    for row in rows:
        row.status = 'confirmed'
    db.commit()
    for row in rows:
        db.refresh(row)
        broadcaster.publish("reservation_confirmed", _sse_payload(row))
    log_event(
        "reservation_confirmed",
        id=res.id,
        room_id=res.room_id,
        date=str(res.date),
        team=res.team_name,
        by=admin.username,
    )
    audit(db, admin, "reservation.confirm", res.team_name,
          f"{res.date} {res.start_time}~{res.end_time}", request)
    return res


@router.delete("/api/reservations/{reservation_id}")
def delete_reservation(
    reservation_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    rows = _group_rows(db, res)
    payloads = [{"id": r.id, "room_id": r.room_id, "date": str(r.date)} for r in rows]
    team = res.team_name
    audit(db, admin, "reservation.delete", team,
          " / ".join(f"{r.date} {r.start_time}~{r.end_time}" for r in rows), request)
    for row in rows:
        db.delete(row)
    db.commit()
    for payload in payloads:
        broadcaster.publish("reservation_deleted", payload)
        log_event(
            "reservation_deleted",
            id=payload["id"],
            room_id=payload["room_id"],
            date=payload["date"],
            team=team,
            by=admin.username,
        )
    return {"message": "취소되었습니다."}
