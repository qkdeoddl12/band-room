from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import datetime, timedelta
from typing import List, Optional
import asyncio
import logging

from database import get_db
from broadcaster import broadcaster
from app_logging import log_event
from deps import get_current_admin
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


@router.post("/api/reservations", response_model=schemas.ReservationResponse)
def create_reservation(
    reservation: schemas.ReservationCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    team = db.query(models.Team).filter(models.Team.id == reservation.team_id).first()
    if not team or not team.is_active:
        raise HTTPException(400, "등록되지 않은 팀입니다. 문의하기로 팀 등록을 요청해주세요.")

    if not db.query(models.Room).filter(models.Room.id == reservation.room_id).first():
        raise HTTPException(400, "존재하지 않는 공간입니다.")

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
                team=team.name,
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
        team_id=team.id,
        date=reservation.date,
        start_time=reservation.start_time,
        end_time=end_time,
        duration=reservation.duration,
        team_name=team.name,
        members=reservation.members,
        note=reservation.note,
        # 월 이용료·월회비 팀은 건별 입금이 없으므로 입금 확인 단계를 건너뛴다.
        status='pending' if team.is_hourly else 'confirmed',
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
        status=db_r.status,
        client=request.client.host if request.client else None,
    )
    return db_r


@router.post("/api/reservations/{reservation_id}/confirm", response_model=schemas.ReservationResponse)
def confirm_reservation(
    reservation_id: int,
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
    return res


@router.delete("/api/reservations/{reservation_id}")
def delete_reservation(
    reservation_id: int,
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
