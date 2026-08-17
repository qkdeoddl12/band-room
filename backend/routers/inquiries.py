from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List, Optional

from database import get_db
from app_logging import log_event
from deps import get_current_admin, normalize_phone, audit
import models
import schemas

router = APIRouter(tags=["inquiries"])


@router.post("/api/inquiries", response_model=schemas.InquiryResponse)
def create_inquiry(
    data: schemas.InquiryCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    inq = models.Inquiry(
        category=data.category,
        content=data.content.strip(),
        contact_name=(data.contact_name or '').strip() or None,
        contact_phone=normalize_phone(data.contact_phone),
    )
    db.add(inq)
    db.commit()
    db.refresh(inq)
    log_event(
        "inquiry_created",
        id=inq.id,
        category=inq.category,
        has_contact=bool(inq.contact_phone or inq.contact_name),
        client=request.client.host if request.client else None,
    )
    return inq


@router.get("/api/admin/inquiries", response_model=List[schemas.InquiryResponse])
def list_inquiries(
    status: Optional[str] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(models.Inquiry)
    if status in ('new', 'resolved'):
        query = query.filter(models.Inquiry.status == status)
    return query.order_by(models.Inquiry.created_at.desc()).all()


@router.post("/api/admin/inquiries/{inquiry_id}/resolve", response_model=schemas.InquiryResponse)
def resolve_inquiry(
    inquiry_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    inq = db.query(models.Inquiry).filter(models.Inquiry.id == inquiry_id).first()
    if not inq:
        raise HTTPException(404, "문의를 찾을 수 없습니다.")
    if inq.status == 'resolved':
        raise HTTPException(400, "이미 처리된 문의입니다.")
    inq.status = 'resolved'
    inq.resolved_by = admin.username
    inq.resolved_at = datetime.utcnow()
    db.commit()
    db.refresh(inq)
    log_event("inquiry_resolved", id=inq.id, category=inq.category, by=admin.username)
    audit(db, admin, "inquiry.resolve", f"#{inq.id} {inq.category}", request=request)
    return inq


@router.delete("/api/admin/inquiries/{inquiry_id}")
def delete_inquiry(
    inquiry_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    inq = db.query(models.Inquiry).filter(models.Inquiry.id == inquiry_id).first()
    if not inq:
        raise HTTPException(404, "문의를 찾을 수 없습니다.")
    db.delete(inq)
    db.commit()
    log_event("inquiry_deleted", id=inquiry_id, by=admin.username)
    audit(db, admin, "inquiry.delete", f"#{inquiry_id}", request=request)
    return {"message": "삭제되었습니다."}
