from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from sqlalchemy import text
from sqlalchemy.orm import Session
from typing import List
from urllib.parse import urlparse
import os
import secrets

from database import get_db
from app_logging import log_event
from deps import get_current_admin, audit, get_or_404, clean_http_url
from uploads_util import save_image
import models
import schemas

router = APIRouter(tags=["tickets"])

def _clean_map_url(value):
    """공개 페이지 href 로 나가는 값. 규칙은 deps 에 모아 뒀다 (레퍼토리 링크와 공유)."""
    return clean_http_url(value, "지도 링크")


def _new_slug(db: Session) -> str:
    # 소문자·숫자만 — 공유 링크를 불러줄 때 대소문자를 따질 일이 없다.
    for _ in range(10):
        slug = secrets.token_hex(6)
        if not db.query(models.Ticket).filter(models.Ticket.slug == slug).first():
            return slug
    raise HTTPException(500, "티켓 주소 생성에 실패했습니다. 다시 시도해주세요.")


@router.get("/api/tickets/{slug}", response_model=schemas.TicketPublic)
def get_public_ticket(slug: str, db: Session = Depends(get_db)):
    ticket = db.query(models.Ticket).filter(
        models.Ticket.slug == slug,
        models.Ticket.is_published == True,
    ).first()
    if not ticket:
        raise HTTPException(404, "티켓을 찾을 수 없습니다.")
    return ticket


# 공유·복사 집계. 공개 엔드포인트라 인증이 없다 — 정확한 통계가 아니라 참고 수치다.
COUNTABLE = {"share": "share_count", "copy": "copy_count"}


@router.post("/api/tickets/{slug}/event")
def record_ticket_event(slug: str, payload: dict, db: Session = Depends(get_db)):
    column = COUNTABLE.get((payload or {}).get("type"))
    if not column:
        raise HTTPException(400, "알 수 없는 이벤트입니다.")
    ticket = db.query(models.Ticket).filter(
        models.Ticket.slug == slug,
        models.Ticket.is_published == True,
    ).first()
    if not ticket:
        raise HTTPException(404, "티켓을 찾을 수 없습니다.")
    db.execute(
        text(f"UPDATE tickets SET {column} = {column} + 1 WHERE id = :id"),
        {"id": ticket.id},
    )
    db.commit()
    return {"ok": True}


@router.get("/api/admin/tickets", response_model=List[schemas.TicketResponse])
def list_tickets(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    return db.query(models.Ticket).order_by(models.Ticket.created_at.desc()).all()


@router.post("/api/admin/tickets", response_model=schemas.TicketResponse)
def create_ticket(
    data: schemas.TicketCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    ticket = models.Ticket(
        slug=_new_slug(db),
        title=data.title.strip(),
        elements=[],
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    log_event("ticket_created", id=ticket.id, slug=ticket.slug, by=admin.username)
    audit(db, admin, "ticket.create", ticket.title, f"/t/{ticket.slug}", request)
    return ticket


@router.get("/api/admin/tickets/{ticket_id}", response_model=schemas.TicketResponse)
def get_ticket(
    ticket_id: int,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    return get_or_404(db, models.Ticket, ticket_id, "티켓을 찾을 수 없습니다.")


@router.put("/api/admin/tickets/{ticket_id}", response_model=schemas.TicketResponse)
def update_ticket(
    ticket_id: int,
    data: schemas.TicketUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    ticket = get_or_404(db, models.Ticket, ticket_id, "티켓을 찾을 수 없습니다.")

    fields = data.model_dump(exclude_unset=True)
    if 'title' in fields and fields['title']:
        ticket.title = fields['title'].strip()
    if fields.get('slug') and fields['slug'] != ticket.slug:
        slug = fields['slug']
        if db.query(models.Ticket).filter(
            models.Ticket.slug == slug, models.Ticket.id != ticket_id
        ).first():
            raise HTTPException(400, "이미 쓰고 있는 주소입니다. 다른 주소를 입력해주세요.")
        # 주소를 바꾸면 이전에 뿌린 링크는 더 이상 열리지 않는다.
        log_event("ticket_slug_changed", id=ticket.id, old=ticket.slug, new=slug, by=admin.username)
        ticket.slug = slug
    if 'bg_url' in fields:
        bg = fields['bg_url']
        if bg and not bg.startswith('/uploads/'):
            raise HTTPException(400, "배경 이미지는 업로드된 파일만 사용할 수 있습니다.")
        ticket.bg_url = bg or None
    if 'map_url' in fields:
        ticket.map_url = _clean_map_url(fields['map_url'])
    if 'aspect' in fields and fields['aspect']:
        ticket.aspect = fields['aspect']
    if 'elements' in fields and fields['elements'] is not None:
        ticket.elements = fields['elements']
    if 'is_published' in fields and fields['is_published'] is not None:
        ticket.is_published = fields['is_published']

    db.commit()
    db.refresh(ticket)
    log_event(
        "ticket_updated",
        id=ticket.id,
        slug=ticket.slug,
        published=ticket.is_published,
        elements=len(ticket.elements or []),
        by=admin.username,
    )
    audit(db, admin, "ticket.update", ticket.title,
          ("공개" if ticket.is_published else "비공개") +
          " · 바꾼 항목: " + (", ".join(fields) or "없음"), request)
    return ticket


@router.delete("/api/admin/tickets/{ticket_id}")
def delete_ticket(
    ticket_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    ticket = get_or_404(db, models.Ticket, ticket_id, "티켓을 찾을 수 없습니다.")
    slug = ticket.slug
    db.delete(ticket)
    db.commit()
    log_event("ticket_deleted", id=ticket_id, slug=slug, by=admin.username)
    audit(db, admin, "ticket.delete", slug, request=request)
    return {"message": "삭제되었습니다."}


@router.post("/api/admin/tickets/upload")
async def upload_ticket_image(
    file: UploadFile = File(...),
    admin: models.AdminUser = Depends(get_current_admin),
):
    """검사·저장 규칙은 uploads_util 한 곳에 있다 (정모 사진과 공유)."""
    url, name, size = await save_image(file)
    log_event("ticket_image_uploaded", file=name, size=size, by=admin.username)
    return {"url": url}
