from fastapi import APIRouter, Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from typing import Optional
import logging
import secrets

from database import get_db
from app_logging import log_event
from deps import (
    SESSION_TTL, get_current_admin, get_current_admin_raw,
    hash_password, verify_password, audit,
)
import models
import schemas

router = APIRouter(prefix="/api/admin", tags=["auth"])

# ponytail: in-memory throttle — assumes a single process. Move to Redis if workers > 1.
LOGIN_WINDOW = timedelta(minutes=5)
LOGIN_MAX_FAILS = 5
# (아이디, 접속 IP) 단위로 센다 — 아이디만으로 세면 남이 틀린 비밀번호를 보내 관리자를 계속 잠근다.
_login_fails: dict[tuple, list[datetime]] = {}


def _recent_fails(key: tuple) -> list[datetime]:
    cutoff = datetime.utcnow() - LOGIN_WINDOW
    fails = [t for t in _login_fails.get(key, []) if t > cutoff]
    if fails:
        _login_fails[key] = fails
    else:
        _login_fails.pop(key, None)
    return fails


def _record_fail(key: tuple):
    # 아무 아이디나 보내도 항목이 쌓이므로 커지면 지난 것을 턴다.
    if len(_login_fails) > 1000:
        for k in list(_login_fails):
            _recent_fails(k)
    _login_fails.setdefault(key, []).append(datetime.utcnow())


@router.post("/login", response_model=schemas.LoginResponse)
def admin_login(
    data: schemas.LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    client = request.client.host if request.client else None
    fail_key = (data.username, client)

    if len(_recent_fails(fail_key)) >= LOGIN_MAX_FAILS:
        log_event("login_blocked", level=logging.WARNING, username=data.username, client=client)
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 5분 후 다시 시도해주세요.")

    user = db.query(models.AdminUser).filter(
        models.AdminUser.username == data.username,
        models.AdminUser.is_active == True,
    ).first()
    if not user or not verify_password(data.password, user.password_hash):
        _record_fail(fail_key)
        log_event(
            "login_failed",
            level=logging.WARNING,
            username=data.username,
            client=client,
            reason="invalid_credentials" if user else "user_not_found_or_inactive",
        )
        raise HTTPException(401, "아이디 또는 비밀번호가 틀렸습니다.")

    _login_fails.pop(fail_key, None)
    audit(db, user, "auth.login", user.username, request=request)
    token = secrets.token_hex(32)
    db.add(models.AdminSession(
        token=token,
        user_id=user.id,
        expires_at=datetime.utcnow() + SESSION_TTL,
    ))
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


@router.post("/change-password", response_model=schemas.AdminUserResponse)
def admin_change_password(
    data: schemas.ChangePasswordRequest,
    admin: models.AdminUser = Depends(get_current_admin_raw),
    x_auth_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    # 남겨진 토큰 하나로 비밀번호를 바꿔 계정을 가져가지 못하게 현재 비밀번호를 받는다.
    if not verify_password(data.current_password, admin.password_hash):
        raise HTTPException(400, "현재 비밀번호가 틀렸습니다.")
    if verify_password(data.new_password, admin.password_hash):
        raise HTTPException(400, "이전과 다른 비밀번호를 사용해주세요.")
    admin.password_hash = hash_password(data.new_password)
    admin.must_change_password = False
    # 다른 곳에 열린 세션은 끊는다 — 털린 토큰이 비밀번호를 바꾼 뒤에도 살아 있으면 안 된다.
    db.query(models.AdminSession).filter(
        models.AdminSession.user_id == admin.id,
        models.AdminSession.token != x_auth_token,
    ).delete(synchronize_session=False)
    db.commit()
    db.refresh(admin)
    log_event("password_changed", username=admin.username)
    audit(db, admin, "auth.password_change", admin.username)
    return admin


@router.post("/logout")
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


@router.get("/me", response_model=schemas.AdminUserResponse)
def admin_me(admin: models.AdminUser = Depends(get_current_admin)):
    return admin
