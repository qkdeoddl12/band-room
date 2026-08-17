from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from typing import List, Optional

from database import get_db
from app_logging import log_event
from deps import get_current_admin, audit, get_or_404
from routers.reservations import _mins, _end_mins
import models
import schemas

router = APIRouter(tags=["blocked"])


@router.get("/api/blocked", response_model=List[schemas.BlockedPeriodResponse])
def list_blocked(
    date: Optional[str] = None,
    room_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.BlockedPeriod)
    if date:
        query = query.filter(models.BlockedPeriod.date == date)
    if room_id is not None:
        query = query.filter(
            (models.BlockedPeriod.room_id == room_id) | (models.BlockedPeriod.room_id.is_(None))
        )
    return query.order_by(
        models.BlockedPeriod.date,
        models.BlockedPeriod.start_time.nullsfirst(),
    ).all()


@router.post("/api/admin/blocked", response_model=schemas.BlockedPeriodResponse)
def create_blocked(
    data: schemas.BlockedPeriodCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    if (data.start_time is None) != (data.end_time is None):
        raise HTTPException(400, "시작·종료 시간은 함께 지정하거나 비워야 합니다.")
    # 종료 00:00 은 '그날 24시'로 본다 (24시간 운영).
    if data.start_time is not None and _mins(data.start_time) >= _end_mins(data.end_time):
        raise HTTPException(400, "종료 시간은 시작 시간 이후여야 합니다.")
    if data.room_id is not None:
        if not db.query(models.Room).filter(models.Room.id == data.room_id).first():
            raise HTTPException(400, "존재하지 않는 공간입니다.")

    blk = models.BlockedPeriod(
        date=data.date,
        start_time=data.start_time,
        end_time=data.end_time,
        room_id=data.room_id,
        reason=data.reason,
        created_by=admin.username,
    )
    db.add(blk)
    db.commit()
    db.refresh(blk)
    log_event(
        "blocked_created",
        id=blk.id,
        date=str(blk.date),
        start=str(blk.start_time) if blk.start_time else "all-day",
        end=str(blk.end_time) if blk.end_time else "all-day",
        room_id=blk.room_id,
        by=admin.username,
    )
    audit(db, admin, "blocked.create", str(blk.date),
          blk.reason or "사유 없음", request)
    return blk


@router.delete("/api/admin/blocked/{blocked_id}")
def delete_blocked(
    blocked_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    blk = get_or_404(db, models.BlockedPeriod, blocked_id, "차단 설정을 찾을 수 없습니다.")
    payload_date = str(blk.date)
    db.delete(blk)
    db.commit()
    log_event(
        "blocked_deleted",
        id=blocked_id,
        date=payload_date,
        by=admin.username,
    )
    audit(db, admin, "blocked.delete", payload_date, request=request)
    return {"message": "삭제되었습니다."}
