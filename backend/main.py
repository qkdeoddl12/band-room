from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response
from sqlalchemy import text
from sqlalchemy.orm import Session
import asyncio
import html
import logging
import os

from database import engine, get_db, SessionLocal
from broadcaster import broadcaster
from app_logging import setup_logging, log_event
from deps import hash_password, generate_temp_password, DEFAULT_SETTINGS
import models

from routers import (
    auth, reservations, admin_users, inquiries, blocked,
    teams, members, dues, tickets, settings,
)

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Band Room API")

FRONTEND_DIR = os.getenv("FRONTEND_DIR", "/app/frontend")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "/app/uploads")
INITIAL_ADMIN_USERNAME = os.getenv("INITIAL_ADMIN_USERNAME", "superadmin")
# 기본 비밀번호를 코드에 박아두지 않는다. 값이 없으면 무작위로 만들어 로그에 한 번만 남긴다.
INITIAL_ADMIN_PASSWORD = os.getenv("INITIAL_ADMIN_PASSWORD", "")


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
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS billing_type VARCHAR(20) NOT NULL DEFAULT 'hourly'",
        "ALTER TABLE teams ADD COLUMN IF NOT EXISTS dues_fee INTEGER",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id)",
        "ALTER TABLE members ADD COLUMN IF NOT EXISTS is_doors BOOLEAN NOT NULL DEFAULT TRUE",
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


# ========== Initial data ==========
ROOM_SEED = [
    ("합주실", "드럼 · 기타앰프 · 베이스앰프 · 보컬PA", 15000),
    ("개인연습실", "개인 · 소규모 연습 공간", 8000),
]


def init_data():
    db = SessionLocal()
    try:
        if db.query(models.Room).count() == 0:
            db.add_all([
                models.Room(name=name, description=desc, hourly_price=price)
                for name, desc, price in ROOM_SEED
            ])
            db.commit()
        else:
            # Existing DBs get hourly_price=0 from the migration — backfill the known defaults.
            for name, _desc, price in ROOM_SEED:
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
    return response


# ========== Routers ==========
for module in (
    auth, reservations, admin_users, inquiries, blocked,
    teams, members, dues, tickets, settings,
):
    app.include_router(module.router)


# ========== Static / Pages ==========
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/")
async def root():
    return FileResponse(f"{FRONTEND_DIR}/index.html")


@app.get("/admin")
async def admin_page():
    return FileResponse(f"{FRONTEND_DIR}/admin.html")


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

    with open(f"{FRONTEND_DIR}/ticket.html", encoding="utf-8") as f:
        page = f.read()

    # Inject OG tags server-side so KakaoTalk/messenger previews show the real ticket.
    base = str(request.base_url).rstrip('/')
    image = f"{base}{ticket.bg_url}" if ticket.bg_url else ""
    og = (
        f'<meta property="og:title" content="{html.escape(ticket.title, quote=True)}">'
        f'<meta property="og:type" content="website">'
        f'<meta property="og:url" content="{base}/t/{html.escape(slug, quote=True)}">'
        f'<meta property="og:image" content="{html.escape(image, quote=True)}">'
    )
    return HTMLResponse(page.replace("<!--OG-->", og))
