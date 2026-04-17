from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import datetime, timedelta
from typing import List, Optional
import asyncio
import os
import secrets
import bcrypt

from database import engine, get_db, SessionLocal
from broadcaster import broadcaster
import models
import schemas

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Band Room Reservation API")

FRONTEND_DIR = os.getenv("FRONTEND_DIR", "/app/frontend")
INITIAL_ADMIN_USERNAME = os.getenv("INITIAL_ADMIN_USERNAME", "superadmin")
INITIAL_ADMIN_PASSWORD = os.getenv("INITIAL_ADMIN_PASSWORD", "superadmin1234")


# ========== Password helpers ==========
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


# ========== Initial data ==========
def init_data():
    db = SessionLocal()
    try:
        if db.query(models.Room).count() == 0:
            db.add_all([
                models.Room(name="합주실", description="드럼 · 기타앰프 · 베이스앰프 · 보컬PA"),
                models.Room(name="개인연습실", description="개인 · 소규모 연습 공간"),
            ])
            db.commit()

        if db.query(models.AdminUser).count() == 0:
            db.add(models.AdminUser(
                username=INITIAL_ADMIN_USERNAME,
                password_hash=hash_password(INITIAL_ADMIN_PASSWORD),
                role='system',
                is_active=True,
            ))
            db.commit()
    finally:
        db.close()


@app.on_event("startup")
async def startup_event():
    init_data()
    broadcaster.attach_loop(asyncio.get_event_loop())


# ========== Auth dependencies ==========
def get_current_admin(
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> models.AdminUser:
    if not x_auth_token:
        raise HTTPException(401, "인증이 필요합니다.")
    session = db.query(models.AdminSession).filter(
        models.AdminSession.token == x_auth_token
    ).first()
    if not session:
        raise HTTPException(401, "유효하지 않은 토큰입니다.")
    if not session.user.is_active:
        raise HTTPException(403, "비활성화된 계정입니다.")
    return session.user


def require_system_admin(
    admin: models.AdminUser = Depends(get_current_admin),
) -> models.AdminUser:
    if admin.role != 'system':
        raise HTTPException(403, "시스템 관리자만 접근 가능합니다.")
    return admin


# ========== Static / Pages ==========
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(f"{FRONTEND_DIR}/index.html")


@app.get("/admin")
async def admin_page():
    return FileResponse(f"{FRONTEND_DIR}/admin.html")


# ========== Public: Rooms ==========
@app.get("/api/rooms", response_model=List[schemas.Room])
def get_rooms(db: Session = Depends(get_db)):
    return db.query(models.Room).all()


# ========== Public: Reservations ==========
@app.get("/api/reservations", response_model=List[schemas.ReservationResponse])
def get_reservations(
    date: Optional[str] = None,
    room_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Reservation)
    if date:
        query = query.filter(models.Reservation.date == date)
    if room_id:
        query = query.filter(models.Reservation.room_id == room_id)
    return query.order_by(models.Reservation.date, models.Reservation.start_time).all()


@app.get("/api/reservations/stream")
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


@app.post("/api/reservations", response_model=schemas.ReservationResponse)
def create_reservation(reservation: schemas.ReservationCreate, db: Session = Depends(get_db)):
    start_dt = datetime.combine(reservation.date, reservation.start_time)
    end_dt = start_dt + timedelta(hours=reservation.duration)
    end_time = end_dt.time()

    existing = db.query(models.Reservation).filter(
        models.Reservation.room_id == reservation.room_id,
        models.Reservation.date == reservation.date,
    ).all()
    for r in existing:
        if not (end_time <= r.start_time or reservation.start_time >= r.end_time):
            raise HTTPException(400, "해당 시간에 이미 예약이 있습니다.")

    db_r = models.Reservation(
        room_id=reservation.room_id,
        date=reservation.date,
        start_time=reservation.start_time,
        end_time=end_time,
        duration=reservation.duration,
        team_name=reservation.team_name,
        members=reservation.members,
        note=reservation.note,
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
    })
    return db_r


@app.delete("/api/reservations/{reservation_id}")
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
    db.delete(res)
    db.commit()
    broadcaster.publish("reservation_deleted", payload)
    return {"message": "취소되었습니다."}


# ========== Admin: Auth ==========
@app.post("/api/admin/login", response_model=schemas.LoginResponse)
def admin_login(data: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.AdminUser).filter(
        models.AdminUser.username == data.username,
        models.AdminUser.is_active == True,
    ).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "아이디 또는 비밀번호가 틀렸습니다.")

    token = secrets.token_hex(32)
    db.add(models.AdminSession(token=token, user_id=user.id))
    db.commit()
    return {"token": token, "username": user.username, "role": user.role}


@app.post("/api/admin/logout")
def admin_logout(
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    if x_auth_token:
        db.query(models.AdminSession).filter(
            models.AdminSession.token == x_auth_token
        ).delete()
        db.commit()
    return {"message": "logged out"}


@app.get("/api/admin/me", response_model=schemas.AdminUserResponse)
def admin_me(admin: models.AdminUser = Depends(get_current_admin)):
    return admin


# ========== Admin: User Management (system admin only) ==========
@app.get("/api/admin/users", response_model=List[schemas.AdminUserResponse])
def list_admin_users(
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    return db.query(models.AdminUser).order_by(models.AdminUser.created_at.desc()).all()


@app.post("/api/admin/users", response_model=schemas.AdminUserResponse)
def create_admin_user(
    data: schemas.CreateUserRequest,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    if db.query(models.AdminUser).filter(models.AdminUser.username == data.username).first():
        raise HTTPException(400, "이미 존재하는 아이디입니다.")
    new_user = models.AdminUser(
        username=data.username,
        password_hash=hash_password(data.password),
        role=data.role,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user


@app.patch("/api/admin/users/{user_id}", response_model=schemas.AdminUserResponse)
def update_admin_user(
    user_id: int,
    data: schemas.UpdateUserRequest,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    user = db.query(models.AdminUser).filter(models.AdminUser.id == user_id).first()
    if not user:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")

    if data.password is not None:
        user.password_hash = hash_password(data.password)

    if data.role is not None and data.role != user.role:
        if user.role == 'system':
            other_systems = db.query(models.AdminUser).filter(
                models.AdminUser.role == 'system',
                models.AdminUser.id != user_id,
                models.AdminUser.is_active == True,
            ).count()
            if other_systems == 0:
                raise HTTPException(400, "마지막 시스템 관리자의 역할은 변경할 수 없습니다.")
        user.role = data.role

    if data.is_active is not None and data.is_active != user.is_active:
        if user.id == admin.id and not data.is_active:
            raise HTTPException(400, "자기 자신은 비활성화할 수 없습니다.")
        if user.role == 'system' and not data.is_active:
            other_systems = db.query(models.AdminUser).filter(
                models.AdminUser.role == 'system',
                models.AdminUser.id != user_id,
                models.AdminUser.is_active == True,
            ).count()
            if other_systems == 0:
                raise HTTPException(400, "마지막 활성 시스템 관리자는 비활성화할 수 없습니다.")
        user.is_active = data.is_active

    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/admin/users/{user_id}")
def delete_admin_user(
    user_id: int,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    if user_id == admin.id:
        raise HTTPException(400, "자기 자신은 삭제할 수 없습니다.")

    user = db.query(models.AdminUser).filter(models.AdminUser.id == user_id).first()
    if not user:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")

    if user.role == 'system':
        other_systems = db.query(models.AdminUser).filter(
            models.AdminUser.role == 'system',
            models.AdminUser.id != user_id,
        ).count()
        if other_systems == 0:
            raise HTTPException(400, "마지막 시스템 관리자는 삭제할 수 없습니다.")

    db.delete(user)
    db.commit()
    return {"message": "삭제되었습니다."}
