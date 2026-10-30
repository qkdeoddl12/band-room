from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from typing import List, Optional

from database import get_db
from deps import require_system_admin, audit
import models
import schemas

router = APIRouter(prefix="/api/admin/audit", tags=["audit"])

# 오래된 기록은 자동으로 지운다 — 무한정 쌓아둘 이유가 없다.
RETENTION_DAYS = 365


@router.get("", response_model=List[schemas.AuditLogResponse])
def list_audit_logs(
    action: Optional[str] = None,
    username: Optional[str] = None,
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(200, ge=1, le=1000),
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    since = datetime.utcnow() - timedelta(days=days)
    query = db.query(models.AuditLog).filter(models.AuditLog.at >= since)
    if action:
        # 'team' 처럼 접두어만 줘도 team.create / team.update 가 함께 잡히게.
        query = query.filter(models.AuditLog.action.like(f"{action}%"))
    if username:
        query = query.filter(models.AuditLog.username == username)
    return query.order_by(models.AuditLog.at.desc()).limit(limit).all()


@router.get("/actions", response_model=List[str])
def list_actions(
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """필터 드롭다운용 — 실제로 기록된 동작 종류만 돌려준다."""
    rows = db.query(models.AuditLog.action).distinct().all()
    return sorted({r[0].split('.')[0] for r in rows if r[0]})


@router.delete("/cleanup")
def cleanup_audit_logs(
    request: Request,
    days: int = Query(RETENTION_DAYS, ge=30, le=3650),
    admin: models.AdminUser = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    cutoff = datetime.utcnow() - timedelta(days=days)
    removed = db.query(models.AuditLog).filter(models.AuditLog.at < cutoff).delete()
    db.commit()
    audit(db, admin, "audit.cleanup", target=f"{days}일 이전",
          detail=f"{removed}건 삭제", request=request)
    return {"removed": removed}
