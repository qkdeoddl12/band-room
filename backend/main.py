from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response
from sqlalchemy import text
from sqlalchemy.orm import Session
import asyncio
import html
import logging
import os
import re

from database import engine, get_db, SessionLocal
from broadcaster import broadcaster
from app_logging import setup_logging, log_event
from deps import hash_password, generate_temp_password, DEFAULT_SETTINGS
import models

from routers import (
    auth, reservations, admin_users, inquiries, blocked,
    teams, members, dues, tickets, settings, audit,
)

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Band Room API")

FRONTEND_DIR = os.getenv("FRONTEND_DIR", "/app/frontend")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "/app/uploads")
INITIAL_ADMIN_USERNAME = os.getenv("INITIAL_ADMIN_USERNAME", "superadmin")
# 기본 비밀번호를 코드에 박아두지 않는다. 값이 없으면 무작위로 만들어 로그에 한 번만 남긴다.
INITIAL_ADMIN_PASSWORD = os.getenv("INITIAL_ADMIN_PASSWORD", "")
# 카톡·메신저 미리보기가 쓰는 절대 주소. 프록시 헤더가 못 미더울 때 확실하게 못 박는다.
# 예: https://band.ericwoolab.com
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")


# ========== DB migrations (lightweight — no Alembic) ==========
def migrate_schema():
    statements = [
        "ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id)",
        "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS hourly_price INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS monthly_fee INTEGER",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS gender VARCHAR(10)",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS birth_year INTEGER",
        "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS map_url VARCHAR(500)",
        "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS share_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS copy_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS billing_type VARCHAR(20) NOT NULL DEFAULT 'hourly'",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS dues_fee INTEGER",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS parts VARCHAR(200)",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id)",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS is_doors BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS needs_check BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS booking_mode VARCHAR(20) NOT NULL DEFAULT 'team'",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS member_id INTEGER REFERENCES members(id)",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booker_name VARCHAR(50)",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booker_phone VARCHAR(30)",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS group_key VARCHAR(32)",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancel_token VARCHAR(32)",
        # 팀 레퍼토리. 팀을 지우면 곡도 함께 지워진다.
        "CREATE TABLE IF NOT EXISTS team_songs ("
        " id SERIAL PRIMARY KEY,"
        " team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,"
        " title VARCHAR(200) NOT NULL,"
        " artist VARCHAR(100),"
        " link VARCHAR(500),"
        " memo TEXT,"
        " status VARCHAR(20) NOT NULL DEFAULT 'candidate',"
        " created_at TIMESTAMP DEFAULT NOW())",
        "CREATE INDEX IF NOT EXISTS ix_team_songs_team_id ON team_songs (team_id)",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_doors BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'team'",
        "CREATE INDEX IF NOT EXISTS ix_reservations_kind ON reservations (kind)",
        # 한 사람이 밴드를 여러 개 하는 경우. members.team_id 는 대표 팀으로만 남는다.
        "CREATE TABLE IF NOT EXISTS member_teams ("
        " member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,"
        " team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,"
        " dues_exempt BOOLEAN NOT NULL DEFAULT FALSE,"
        " PRIMARY KEY (member_id, team_id))",
        "ALTER TABLE member_teams ALTER COLUMN dues_exempt SET DEFAULT FALSE",
        "INSERT INTO member_teams (member_id, team_id, dues_exempt)"
        " SELECT id, team_id, FALSE FROM members WHERE team_id IS NOT NULL"
        " ON CONFLICT DO NOTHING",
        "ALTER TABLE member_dues ADD COLUMN IF NOT EXISTS team_id INTEGER"
        " REFERENCES teams(id) ON DELETE CASCADE",
    ]
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))
        # billing_type 도입 전에는 monthly_fee 유무로 월정액 여부를 판단했다.
        # 기존 행을 한 번만 옮겨준다 (이미 옮겨진 행은 건드리지 않음).
        conn.execute(text(
            "UPDATE teams SET billing_type = 'monthly' "
            "WHERE monthly_fee IS NOT NULL AND billing_type = 'hourly'"
        ))
        # is_free 도입 전 예약은 선불 팀 여부로 되짚어 채운다.
        conn.execute(text(
            "UPDATE reservations r SET is_free = TRUE FROM teams t "
            "WHERE r.team_id = t.id AND t.billing_type <> 'hourly' AND r.is_free = FALSE"
        ))
        # kind 도입 전 예약은 팀 유무로 되짚어 채운다. 기본값이 'team' 이라
        # 팀 없이 만들어졌던 개인연습실 예약만 고쳐주면 된다.
        conn.execute(text(
            "UPDATE reservations SET kind = 'personal' "
            "WHERE team_id IS NULL AND kind = 'team'"
        ))
        # 개인연습실은 팀이 아니라 개인이 쓴다. 아직 개인용 방이 하나도 없을 때만
        # 한 번 지정한다 (관리자가 나중에 바꾼 설정을 되돌리지 않도록).
        conn.execute(text(
            "UPDATE rooms SET booking_mode = 'personal' WHERE name = '개인연습실' "
            "AND NOT EXISTS (SELECT 1 FROM rooms WHERE booking_mode = 'personal')"
        ))
        # 회비가 (멤버, 달) 에서 (멤버, 팀, 달) 로 넓어졌다. 옛 유니크 키가 아직
        # 남아 있을 때 = 이 DB 에서 처음 도는 경우에만 기존 기록을 그 사람 팀으로 옮긴다.
        # 가드가 없으면 나중에 무소속(team_id IS NULL) 기록까지 덧칠해 버린다.
        if conn.execute(text(
            "SELECT 1 FROM pg_constraint WHERE conname = 'uq_member_dues_month'"
        )).first():
            conn.execute(text(
                "UPDATE member_dues d SET team_id = m.team_id FROM members m "
                "WHERE d.member_id = m.id AND m.team_id IS NOT NULL"
            ))
            conn.execute(text("ALTER TABLE member_dues DROP CONSTRAINT uq_member_dues_month"))
        # 새 DB 는 create_all 이 같은 이름으로 이미 만들어 둔다 (IF NOT EXISTS 로 흡수).
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_member_dues_team_month "
            "ON member_dues (member_id, team_id, year_month) NULLS NOT DISTINCT"
        ))


# ========== Initial data ==========
ROOM_SEED = [
    # (이름, 설명, 시간당 요금, 예약 단위)
    ("합주실", "드럼 · 기타앰프 · 베이스앰프 · 보컬PA", 15000, "team"),
    ("개인연습실", "개인 · 소규모 연습 공간", 8000, "personal"),
]


def init_data():
    db = SessionLocal()
    try:
        if db.query(models.Room).count() == 0:
            db.add_all([
                models.Room(name=name, description=desc, hourly_price=price, booking_mode=mode)
                for name, desc, price, mode in ROOM_SEED
            ])
            db.commit()
        else:
            # Existing DBs get hourly_price=0 from the migration — backfill the known defaults.
            for name, _desc, price, _mode in ROOM_SEED:
                room = db.query(models.Room).filter(models.Room.name == name).first()
                if room and not room.hourly_price:
                    room.hourly_price = price
            db.commit()

        existing_keys = {s.key for s in db.query(models.AppSetting).all()}
        for key, value in DEFAULT_SETTINGS.items():
            if key not in existing_keys:
                db.add(models.AppSetting(key=key, value=value))
        db.commit()

        if db.query(models.AdminUser).count() == 0:
            password = INITIAL_ADMIN_PASSWORD or generate_temp_password(16)
            db.add(models.AdminUser(
                username=INITIAL_ADMIN_USERNAME,
                password_hash=hash_password(password),
                role='system',
                # 무작위로 만든 경우엔 첫 로그인에서 반드시 바꾸게 한다.
                must_change_password=not INITIAL_ADMIN_PASSWORD,
                is_active=True,
            ))
            db.commit()
            if not INITIAL_ADMIN_PASSWORD:
                log_event(
                    "initial_admin_created",
                    level=logging.WARNING,
                    username=INITIAL_ADMIN_USERNAME,
                    generated_password=password,
                    note="INITIAL_ADMIN_PASSWORD 미설정 — 로그의 이 비밀번호로 로그인 후 즉시 변경하세요",
                )
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
    # HTML 셸과 /static 스크립트는 항상 재검증한다.
    # 캐시 수명이 서로 달라지면 옛 admin.html 에 새 JS 가 붙어 화면이 죽는다 (겪음).
    path = request.url.path
    if path in ('/', '/admin') or path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


# ========== Routers ==========
for module in (
    auth, reservations, admin_users, inquiries, blocked,
    teams, members, dues, tickets, settings, audit,
):
    app.include_router(module.router)


# ========== Static / Pages ==========
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


ASSET_REF = re.compile(r'(?<=["\'])(/static/[^"\']+\.(?:js|css))(?=["\'])')


def asset_version() -> str:
    """frontend 의 js/css 중 가장 최근 수정 시각. 파일이 바뀌면 값이 바뀐다."""
    latest = 0.0
    for root, _dirs, files in os.walk(FRONTEND_DIR):
        for name in files:
            if name.endswith(('.js', '.css')):
                latest = max(latest, os.path.getmtime(os.path.join(root, name)))
    return str(int(latest))


def render_page(filename: str) -> str:
    """정적 자원 주소에 버전을 붙여 돌려준다.

    브라우저가 옛 JS 를 들고 있으면 새 HTML 과 짝이 안 맞아 화면이 죽는다.
    Cache-Control 은 이미 캐시된 사본에 소급되지 않으므로 주소 자체를 바꾼다.
    """
    with open(f"{FRONTEND_DIR}/{filename}", encoding="utf-8") as f:
        page = f.read()
    return ASSET_REF.sub(rf"\1?v={asset_version()}", page)


@app.get("/", response_class=HTMLResponse)
async def root():
    return HTMLResponse(render_page("index.html"))


@app.get("/guide", response_class=HTMLResponse)
async def guide_page():
    """예약 이용안내. 화면으로도 보고 브라우저 인쇄로 PDF 로도 뽑는다."""
    return HTMLResponse(render_page("guide.html"))


@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    return HTMLResponse(render_page("admin.html"))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    # 브라우저가 <link> 를 못 본 경우(북마크 등)를 위한 대비.
    path = f"{FRONTEND_DIR}/favicon.svg"
    if os.path.exists(path):
        return FileResponse(path, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/t/{slug}", response_class=HTMLResponse)
async def ticket_page(slug: str, request: Request, db: Session = Depends(get_db)):
    ticket = db.query(models.Ticket).filter(
        models.Ticket.slug == slug,
        models.Ticket.is_published == True,
    ).first()
    if not ticket:
        raise HTTPException(404, "티켓을 찾을 수 없습니다.")

    # 페이지가 실제로 열릴 때만 센다. 카톡 미리보기 봇도 함께 잡히므로 참고용 수치다.
    db.execute(
        text("UPDATE tickets SET view_count = view_count + 1 WHERE id = :id"),
        {"id": ticket.id},
    )
    db.commit()

    page = render_page("ticket.html")

    # Inject OG tags server-side so KakaoTalk/messenger previews show the real ticket.
    # 이미지 주소가 외부에서 열리지 않으면 미리보기가 흰 칸으로 뜬다.
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip('/')
    esc = lambda v: html.escape(str(v), quote=True)
    url = f"{base}/t/{esc(slug)}"
    tags = [
        ('og:site_name', 'Band Room'),
        ('og:type', 'website'),
        ('og:title', ticket.title),
        ('og:description', '공연 티켓 · 눌러서 확인하세요'),
        ('og:url', url),
    ]
    if ticket.bg_url:
        tags += [
            ('og:image', f"{base}{ticket.bg_url}"),
            ('og:image:secure_url', f"{base}{ticket.bg_url}"),
            ('og:image:alt', ticket.title),
        ]
    og = ''.join(f'<meta property="{k}" content="{esc(v)}">' for k, v in tags)
    og += '<meta name="twitter:card" content="summary_large_image">'
    return HTMLResponse(page.replace("<!--OG-->", og))
