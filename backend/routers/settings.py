from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from app_logging import log_event
from deps import require_system_admin, get_settings, DEFAULT_SETTINGS, audit
import models
import schemas

router = APIRouter(tags=["settings"])

EDITABLE_KEYS = set(DEFAULT_SETTINGS)


@router.get("/api/settings", response_model=schemas.PublicSettings)
def public_settings(db: Session = Depends(get_db)):
    """예약 페이지에서 쓰는 입금 계좌 정보만."""
    values = get_settings(db)
    return schemas.PublicSettings(
        deposit_bank=values.get("deposit_bank", ""),
        deposit_account=values.get("deposit_account", ""),
        deposit_holder=values.get("deposit_holder", ""),
    )


@router.get("/api/admin/settings")
def admin_settings(
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    rooms = db.query(models.Room).order_by(models.Room.id).all()
    return {
        "values": get_settings(db),
        "rooms": [
            {
                "id": r.id, "name": r.name,
                "hourly_price": r.hourly_price,
                "booking_mode": r.booking_mode,
            }
            for r in rooms
        ],
    }


@router.put("/api/admin/settings")
def update_settings(
    data: schemas.SettingsUpdate,
    request: Request,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    unknown = set(data.values) - EDITABLE_KEYS
    if unknown:
        raise HTTPException(400, f"알 수 없는 설정 항목: {', '.join(sorted(unknown))}")
    for key, label in (("default_monthly_fee", "기본 월회비"), ("default_team_fee", "기본 팀 이용료")):
        if key in data.values:
            try:
                if int(data.values[key]) < 0:
                    raise ValueError
            except ValueError:
                raise HTTPException(400, f"{label}는 0 이상의 숫자여야 합니다.")

    for key, value in data.values.items():
        row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(models.AppSetting(key=key, value=value))
    db.commit()
    log_event("settings_updated", keys=",".join(sorted(data.values)), by=admin.username)
    audit(db, admin, "settings.update", ", ".join(sorted(data.values)),
          request=request)
    return {"values": get_settings(db)}


@router.put("/api/admin/rooms/{room_id}/price")
def update_room_price(
    room_id: int,
    payload: dict,
    request: Request,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    room = db.query(models.Room).filter(models.Room.id == room_id).first()
    if not room:
        raise HTTPException(404, "공간을 찾을 수 없습니다.")
    try:
        price = int(payload.get("hourly_price"))
    except (TypeError, ValueError):
        raise HTTPException(400, "요금은 숫자여야 합니다.")
    if price < 0:
        raise HTTPException(400, "요금은 0 이상이어야 합니다.")
    room.hourly_price = price

    mode = payload.get("booking_mode")
    if mode is not None:
        if mode not in ("team", "personal"):
            raise HTTPException(400, "예약 단위는 team 또는 personal 이어야 합니다.")
        room.booking_mode = mode

    db.commit()
    log_event(
        "room_updated", room_id=room_id, price=price,
        mode=room.booking_mode, by=admin.username,
    )
    audit(db, admin, "room.update", room.name,
          f"시간당 {price:,}원 · 예약 단위 {room.booking_mode}", request)
    return {
        "id": room.id, "name": room.name,
        "hourly_price": room.hourly_price, "booking_mode": room.booking_mode,
    }
