from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import datetime, timedelta
from typing import List, Optional
import asyncio
import os
import secrets
import string
import bcrypt

from database import engine, get_db, SessionLocal
from broadcaster import broadcaster
from app_logging import setup_logging, log_event, logger
import logging
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


def generate_temp_password(length: int = 10) -> str:
    # Readable alphabet: exclude similar-looking chars (0/O, 1/l/I)
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return ''.join(secrets.choice(alphabet) for _ in range(length))


# ========== DB migrations (lightweight) ==========
def migrate_schema():
    # Add must_change_password column if missing (for existing deployments).
    with engine.begin() as conn:
        conn.execute(text(
            "ALTER TABLE admin_users "
            "ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE"
        ))


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
    setup_logging()
    migrate_schema()
    init_data()
    broadcaster.attach_loop(asyncio.get_event_loop())
    log_event("startup")


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception as exc:
        log_event(
            "unhandled_exception",
            level=logging.ERROR,
            method=request.method,
            path=request.url.path,
            client=request.client.host if request.client else None,
            exc=repr(exc),
        )
        raise
    if response.status_code >= 400:
        log_event(
            "http_error",
            level=logging.WARNING,
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            client=request.client.host if request.client else None,
        )
    return response


# ========== Auth dependencies ==========
def _resolve_session_user(
    x_auth_token: Optional[str],
    db: Session,
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


def get_current_admin_raw(
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> models.AdminUser:
    """Authenticated user; does NOT block must_change_password. Use for password-change endpoint."""
    return _resolve_session_user(x_auth_token, db)


def get_current_admin(
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> models.AdminUser:
    user = _resolve_session_user(x_auth_token, db)
    if user.must_change_password:
        raise HTTPException(403, "비밀번호 변경이 필요합니다.")
    return user


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
def create_reservation(
    reservation: schemas.ReservationCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    start_dt = datetime.combine(reservation.date, reservation.start_time)
    end_dt = start_dt + timedelta(hours=reservation.duration)
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
                team=reservation.team_name,
            )
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
    log_event(
        "reservation_created",
        id=db_r.id,
        room_id=db_r.room_id,
        date=str(db_r.date),
        start=str(db_r.start_time),
        end=str(db_r.end_time),
        team=db_r.team_name,
        client=request.client.host if request.client else None,
    )
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


# ========== Admin: Auth ==========
@app.post("/api/admin/login", response_model=schemas.LoginResponse)
def admin_login(
    data: schemas.LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    client = request.client.host if request.client else None
    user = db.query(models.AdminUser).filter(
        models.AdminUser.username == data.username,
        models.AdminUser.is_active == True,
    ).first()
    if not user or not verify_password(data.password, user.password_hash):
        log_event(
            "login_failed",
            level=logging.WARNING,
            username=data.username,
            client=client,
            reason="invalid_credentials" if user else "user_not_found_or_inactive",
        )
        raise HTTPException(401, "아이디 또는 비밀번호가 틀렸습니다.")

    token = secrets.token_hex(32)
    db.add(models.AdminSession(token=token, user_id=user.id))
    db.commit()
    log_event(
        "login",
        username=user.username,
        role=user.role,
        must_change_password=user.must_change_password,
        client=client,
    )
    return {
        "token": token,
        "username": user.username,
        "role": user.role,
        "must_change_password": user.must_change_password,
    }


@app.post("/api/admin/change-password", response_model=schemas.AdminUserResponse)
def admin_change_password(
    data: schemas.ChangePasswordRequest,
    admin: models.AdminUser = Depends(get_current_admin_raw),
    db: Session = Depends(get_db),
):
    if verify_password(data.new_password, admin.password_hash):
        raise HTTPException(400, "이전과 다른 비밀번호를 사용해주세요.")
    admin.password_hash = hash_password(data.new_password)
    admin.must_change_password = False
    db.commit()
    db.refresh(admin)
    log_event("password_changed", username=admin.username)
    return admin


@app.post("/api/admin/logout")
def admin_logout(
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    if x_auth_token:
        session = db.query(models.AdminSession).filter(
            models.AdminSession.token == x_auth_token
        ).first()
        if session:
            username = session.user.username if session.user else None
            db.delete(session)
            db.commit()
            log_event("logout", username=username)
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


@app.post("/api/admin/users", response_model=schemas.CreateUserResponse)
def create_admin_user(
    data: schemas.CreateUserRequest,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    if db.query(models.AdminUser).filter(models.AdminUser.username == data.username).first():
        raise HTTPException(400, "이미 존재하는 아이디입니다.")

    temp_password = generate_temp_password()
    new_user = models.AdminUser(
        username=data.username,
        password_hash=hash_password(temp_password),
        role=data.role,
        is_active=True,
        must_change_password=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    log_event(
        "user_created",
        by=admin.username,
        target=new_user.username,
        role=new_user.role,
    )
    return {"user": new_user, "temp_password": temp_password}


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

    changes = []
    if data.password is not None:
        user.password_hash = hash_password(data.password)
        changes.append("password")

    if data.role is not None and data.role != user.role:
        if user.role == 'system':
            other_systems = db.query(models.AdminUser).filter(
                models.AdminUser.role == 'system',
                models.AdminUser.id != user_id,
                models.AdminUser.is_active == True,
            ).count()
            if other_systems == 0:
                raise HTTPException(400, "마지막 시스템 관리자의 역할은 변경할 수 없습니다.")
        changes.append(f"role:{user.role}->{data.role}")
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
        changes.append(f"active:{user.is_active}->{data.is_active}")
        user.is_active = data.is_active

    db.commit()
    db.refresh(user)
    log_event(
        "user_updated",
        by=admin.username,
        target=user.username,
        changes=",".join(changes) if changes else "none",
    )
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

    target_username = user.username
    db.delete(user)
    db.commit()
    log_event("user_deleted", by=admin.username, target=target_username)
    return {"message": "삭제되었습니다."}
