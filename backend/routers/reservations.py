from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import date, datetime, timedelta
from typing import List, Optional
import asyncio
import logging

from database import get_db
from broadcaster import broadcaster
from app_logging import log_event
from deps import get_current_admin, normalize_phone, member_dues_ok, audit
import models
import schemas

router = APIRouter(tags=["reservations"])


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
    if end_dt.date() != reservation.date:
        raise HTTPException(400, "예약은 자정을 넘길 수 없습니다.")
    end_time = end_dt.time()

    existing = db.query(models.Reservation).filter(
        models.Reservation.room_id == reservation.room_id,
        models.Reservation.date == reservation.date,
    ).all()
    for r in existing:
        if not (end_time <= r.start_time or reservation.start_time >= r.end_time):
            log_event(
                "reservation_conflict",
                level=logging.WARNING,
                client=request.client.host if request.client else None,
                room_id=reservation.room_id,
                date=str(reservation.date),
                start=str(reservation.start_time),
                end=str(end_time),
                team=team.name if team else booker_name,
            )
            raise HTTPException(400, "해당 시간에 이미 예약이 있습니다.")

    blocked = db.query(models.BlockedPeriod).filter(
        models.BlockedPeriod.date == reservation.date,
    ).all()
    for b in blocked:
        if b.room_id is not None and b.room_id != reservation.room_id:
            continue
        if b.start_time is None or b.end_time is None:
            overlaps = True
        else:
            overlaps = not (end_time <= b.start_time or reservation.start_time >= b.end_time)
        if overlaps:
            log_event(
                "reservation_blocked",
                level=logging.WARNING,
                client=request.client.host if request.client else None,
                room_id=reservation.room_id,
                date=str(reservation.date),
                start=str(reservation.start_time),
                end=str(end_time),
                blocked_id=b.id,
                reason=b.reason,
            )
            msg = "해당 시간은 예약이 차단되어 있습니다."
            if b.reason:
                msg += f" ({b.reason})"
            raise HTTPException(400, msg)

    db_r = models.Reservation(
        room_id=reservation.room_id,
        team_id=team.id if team else None,
        member_id=member.id if member else None,
        booker_name=booker_name,
        booker_phone=booker_phone,
        date=reservation.date,
        start_time=reservation.start_time,
        end_time=end_time,
        duration=reservation.duration,
        team_name=team.name if team else booker_name,
        members=reservation.members,
        note=reservation.note,
        # 낼 것이 없는 예약(선불 팀 · 회비 낸 멤버)은 입금 확인 단계를 건너뛴다.
        is_free=free,
        status='confirmed' if free else 'pending',
    )
    db.add(db_r)
    db.commit()
    db.refresh(db_r)

    broadcaster.publish("reservation_created", {
        "id": db_r.id,
        "room_id": db_r.room_id,
        "date": str(db_r.date),
        "start_time": str(db_r.start_time),
        "end_time": str(db_r.end_time),
        "team_name": db_r.team_name,
        "status": db_r.status,
    })
    log_event(
        "reservation_created",
        id=db_r.id,
        room_id=db_r.room_id,
        date=str(db_r.date),
        start=str(db_r.start_time),
        end=str(db_r.end_time),
        team=db_r.team_name,
        member_id=db_r.member_id,
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
    res = db.query(models.Reservation).filter(models.Reservation.id == reservation_id).first()
    if not res:
        raise HTTPException(404, "예약을 찾을 수 없습니다.")
    if res.status == 'confirmed':
        raise HTTPException(400, "이미 확정된 예약입니다.")

    res.status = 'confirmed'
    db.commit()
    db.refresh(res)

    broadcaster.publish("reservation_confirmed", {
        "id": res.id,
        "room_id": res.room_id,
        "date": str(res.date),
        "start_time": str(res.start_time),
        "end_time": str(res.end_time),
        "team_name": res.team_name,
        "status": res.status,
    })
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
    res = db.query(models.Reservation).filter(models.Reservation.id == reservation_id).first()
    if not res:
        raise HTTPException(404, "예약을 찾을 수 없습니다.")
    payload = {
        "id": res.id,
        "room_id": res.room_id,
        "date": str(res.date),
    }
    team = res.team_name
    audit(db, admin, "reservation.delete", team,
          f"{res.date} {res.start_time}~{res.end_time}", request)
    db.delete(res)
    db.commit()
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
