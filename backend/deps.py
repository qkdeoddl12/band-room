"""Shared dependencies: password helpers, admin auth, settings access.

Lives outside routers/ so routers can import it without circular imports.
"""
from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from typing import Optional
import re
import secrets
import bcrypt

from database import get_db
import models

SESSION_TTL = timedelta(hours=12)


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

    now = datetime.utcnow()
    if session.expires_at is not None and session.expires_at <= now:
        db.delete(session)
        db.commit()
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인해주세요.")

    if not session.user.is_active:
        raise HTTPException(403, "비활성화된 계정입니다.")

    # Sliding expiry. Only write when past the halfway mark (or on legacy NULL rows)
    # so we don't hit the DB with an UPDATE on every single request.
    if session.expires_at is None or session.expires_at - now < SESSION_TTL / 2:
        session.expires_at = now + SESSION_TTL
        db.commit()

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


# ========== Parts (포지션) ==========
def clean_parts(parts: Optional[str]) -> Optional[str]:
    """콤마 문자열로 저장한다. 공백 정리 + 중복 제거, 순서는 입력 그대로."""
    if not parts:
        return None
    items = [p.strip() for p in parts.split(',') if p.strip()]
    return ','.join(dict.fromkeys(items)) or None


# ========== Phone ==========
_PHONEISH = re.compile(r'^[\d\s\-()+.]+$')


def normalize_phone(value):
    """전화번호는 숫자만 저장한다 — 화면에 뿌릴 때 하이픈을 붙이므로
    '010-1234-5678' 과 '01012345678' 이 같은 값으로 취급된다.
    번호처럼 안 생긴 값(내선 안내, 메모 섞인 값)은 건드리지 않고 그대로 둔다."""
    text = (value or '').strip()
    if not text:
        return None
    if not _PHONEISH.match(text):
        return text
    digits = re.sub(r'\D', '', text)
    if not digits:
        return None
    # 국제번호의 '+' 는 지우면 복원할 수 없으므로 남긴다.
    return ('+' + digits) if text.startswith('+') else digits


# ========== Audit log ==========
def audit(db: Session, admin, action: str, target=None, detail=None, request=None):
    """감사 로그 한 줄. 실패해도 본 작업을 막지 않는다 —
    기록이 안 됐다고 예약 취소가 되돌아가면 더 곤란하다."""
    try:
        db.add(models.AuditLog(
            username=getattr(admin, 'username', None),
            action=action,
            target=(str(target)[:200] if target is not None else None),
            detail=(str(detail)[:2000] if detail is not None else None),
            ip=(request.client.host if request is not None and request.client else None),
        ))
        db.commit()
    except Exception:
        db.rollback()


# ========== App settings ==========
DEFAULT_SETTINGS = {
    "deposit_bank": "농협",
    "deposit_account": "352-1068-1777-83",
    "deposit_holder": "황은희",
    "default_monthly_fee": "30000",   # 멤버 1인 월회비
    "default_team_fee": "0",          # 팀 월 이용료
}


def get_settings(db: Session) -> dict:
    rows = db.query(models.AppSetting).all()
    values = dict(DEFAULT_SETTINGS)
    values.update({r.key: r.value for r in rows if r.value is not None})
    return values


def resolve_member_fee(member, team, fallback: int) -> int:
    """멤버 개인 금액 > 팀 기본 회비 > 전체 기본값 순으로 적용한다."""
    if member.monthly_fee is not None:
        return member.monthly_fee
    if team is not None and team.dues_fee is not None:
        return team.dues_fee
    return fallback


def member_dues_ok(db: Session, member, year_month: str) -> bool:
    """이번 달 회비가 해결된 상태인지. 면제 회원과 팀이 월 이용료를 내는 회원도
    '해결됨'으로 본다 — 개인이 더 낼 것이 없기 때문."""
    if member.dues_exempt:
        return True
    if member.team is not None and member.team.billing_type == 'monthly':
        return True
    row = db.query(models.MemberDues).filter(
        models.MemberDues.member_id == member.id,
        models.MemberDues.year_month == year_month,
    ).first()
    return bool(row and row.status in ('paid', 'exempt'))


def default_monthly_fee(db: Session) -> int:
    try:
        return int(get_settings(db)["default_monthly_fee"])
    except (ValueError, TypeError):
        return int(DEFAULT_SETTINGS["default_monthly_fee"])
