"""Shared dependencies: password helpers, admin auth, settings access.

Lives outside routers/ so routers can import it without circular imports.
"""
from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session, joinedload
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlparse
import re
import secrets
import time
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
    # user 를 함께 가져온다 — 아래에서 바로 쓰는데 lazy 로 두면 요청마다 쿼리가 2번 나간다.
    session = db.query(models.AdminSession).options(
        joinedload(models.AdminSession.user)
    ).filter(models.AdminSession.token == x_auth_token).first()
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


def set_member_teams(db: Session, member, team_ids, exempt_ids=None):
    """멤버의 소속 팀을 통째로 갈아끼운다. 한 사람이 밴드를 여러 개 할 수 있으므로
    members.team_id 는 '회비 내는 팀' 이 아니라 목록 첫 팀 = 대표 팀일 뿐이다.
    두 값을 여기서만 함께 쓰기 때문에 서로 어긋날 일이 없다.

    exempt_ids 를 주지 않으면 팀별 회비 제외 설정은 건드리지 않는다 (이름만 고칠 때 등)."""
    ids = list(dict.fromkeys(int(t) for t in (team_ids or [])))
    if ids:
        found = {row.id for row in db.query(models.Team.id).filter(models.Team.id.in_(ids)).all()}
        if len(found) != len(ids):
            raise HTTPException(400, "존재하지 않는 팀입니다.")

    exempt = None if exempt_ids is None else {int(t) for t in exempt_ids}
    current = {ms.team_id: ms for ms in member.memberships}
    for team_id, ms in current.items():
        if team_id not in ids:
            member.memberships.remove(ms)   # delete-orphan 이 지운다
    for team_id in ids:
        ms = current.get(team_id)
        if ms is None:
            ms = models.MemberTeam(team_id=team_id)
            member.memberships.append(ms)
        if exempt is not None:
            ms.dues_exempt = team_id in exempt
    member.team_id = ids[0] if ids else None


_hits: dict = {}


def rate_limit(request, bucket: str, limit: int, window: int = 600):
    """로그인 없는 쓰기 API(예약·문의·오픈잼) 도배 방지. IP 마다 window 초에 limit 번.
    shortcut: 프로세스 메모리라 워커가 여럿이면 따로 센다 — 그때는 DB 나 redis 로 옮길 것."""
    ip = request.client.host if request.client else None
    if ip == '127.0.0.1':   # 컨테이너 안 스모크 테스트
        return
    now = time.monotonic()
    key = (bucket, ip)
    recent = [t for t in _hits.get(key, ()) if now - t < window]
    if len(recent) >= limit:
        raise HTTPException(429, "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.")
    recent.append(now)
    _hits[key] = recent
    if len(_hits) > 5000:   # 오래 안 온 IP 는 털어낸다
        for k in [k for k, ts in _hits.items() if now - ts[-1] >= window]:
            del _hits[k]


def get_or_404(db: Session, model, ident, message: str):
    """라우터마다 반복되던 조회+404 세 줄을 한 곳으로."""
    obj = db.query(model).filter(model.id == ident).first()
    if not obj:
        raise HTTPException(404, message)
    return obj


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


# ========== URL ==========
def clean_http_url(value, label: str = "링크"):
    """화면에서 href 로 나가는 값이라 스킴을 반드시 제한한다.
    (javascript: / data: 같은 스킴이 들어오면 링크를 누른 사람에게 스크립트가 실행된다)
    티켓 지도 링크와 레퍼토리 참고 링크가 같은 규칙을 써야 하므로 여기 한 곳에 둔다."""
    url = (value or '').strip()
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise HTTPException(400, f"{label}는 http:// 또는 https:// 로 시작하는 주소만 넣을 수 있습니다.")
    return url


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
    '해결됨'으로 본다 — 개인이 더 낼 것이 없기 때문.

    밴드를 여러 개 하면 회비도 소속마다 따로 있다. 여기서는 하나라도 해결돼 있으면
    통과시킨다 — 개인연습실 무료 판정이라 지금까지의 관대함을 그대로 둔다."""
    if member.dues_exempt:
        return True
    for ms in member.memberships:
        if ms.dues_exempt or (ms.team is not None and ms.team.billing_type == 'monthly'):
            return True
    rows = db.query(models.MemberDues).filter(
        models.MemberDues.member_id == member.id,
        models.MemberDues.year_month == year_month,
    ).all()
    if any(r.status in ('paid', 'exempt') for r in rows):
        return True
    # 운영진·모임장은 기록이 없는 달이면 기본 면제다 (routers/dues.py 의 off 와 같은 규칙).
    if member.role in ('staff', 'leader'):
        slots = {ms.team_id for ms in member.memberships} or {None}
        return bool(slots - {r.team_id for r in rows})
    return False


def default_monthly_fee(db: Session) -> int:
    return _fee_setting(db, "default_monthly_fee")


def default_team_fee(db: Session) -> int:
    """월 이용료를 안 적은 팀이 쓰는 기본값. 멤버 회비와 같은 방식."""
    return _fee_setting(db, "default_team_fee")


def _fee_setting(db: Session, key: str) -> int:
    try:
        return int(get_settings(db)[key])
    except (ValueError, TypeError):
        return int(DEFAULT_SETTINGS[key])
