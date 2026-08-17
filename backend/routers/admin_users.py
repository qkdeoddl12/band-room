from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from typing import List

from database import get_db
from app_logging import log_event
from deps import (
    require_system_admin, hash_password, generate_temp_password, audit, get_or_404,
)
import models
import schemas

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])


@router.get("", response_model=List[schemas.AdminUserResponse])
def list_admin_users(
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    return db.query(models.AdminUser).order_by(models.AdminUser.created_at.desc()).all()


@router.post("", response_model=schemas.CreateUserResponse)
def create_admin_user(
    data: schemas.CreateUserRequest,
    request: Request,
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
    audit(db, admin, "account.create", new_user.username,
          f"권한 {new_user.role}", request)
    return {"user": new_user, "temp_password": temp_password}


@router.patch("/{user_id}", response_model=schemas.AdminUserResponse)
def update_admin_user(
    user_id: int,
    data: schemas.UpdateUserRequest,
    request: Request,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    user = get_or_404(db, models.AdminUser, user_id, "사용자를 찾을 수 없습니다.")

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
    audit(db, admin, "account.update", user.username,
          ", ".join(changes) if changes else "변경 없음", request)
    return user


@router.delete("/{user_id}")
def delete_admin_user(
    user_id: int,
    request: Request,
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    if user_id == admin.id:
        raise HTTPException(400, "자기 자신은 삭제할 수 없습니다.")

    user = get_or_404(db, models.AdminUser, user_id, "사용자를 찾을 수 없습니다.")

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
    audit(db, admin, "account.delete", target_username, request=request)
    return {"message": "삭제되었습니다."}
