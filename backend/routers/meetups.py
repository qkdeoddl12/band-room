"""정모 기록 — 참석자 · 그날 한 곡 · 사진.

기록은 예약(kind='meetup') 한 건에 붙는다. 날짜·장소는 예약이 이미 갖고 있어서
다시 적지 않고 끌어온다. 예약을 지우면 기록도 함께 사라진다.
관리자 전용 — 참가비가 정산으로 이어지고 참석자 명단이 담긴다.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from sqlalchemy.orm import Session, joinedload
from typing import List

from database import get_db
from app_logging import log_event
from deps import get_current_admin, audit, get_or_404
from uploads_util import save_image
import models
import schemas

router = APIRouter(tags=["meetups"])


def _record_query(db: Session):
    return db.query(models.MeetupRecord).options(
        joinedload(models.MeetupRecord.attendees),
        joinedload(models.MeetupRecord.songs),
        joinedload(models.MeetupRecord.reservation).joinedload(models.Reservation.room),
    )


def _view(rec: models.MeetupRecord) -> schemas.MeetupRecordOut:
    res = rec.reservation
    songs = sorted(rec.songs, key=lambda s: (s.sort_order, s.id))
    attendees = sorted(rec.attendees, key=lambda a: a.id)
    walk_ins = [a for a in attendees if a.pay_type == 'walk_in']
    return schemas.MeetupRecordOut(
        id=rec.id, reservation_id=rec.reservation_id,
        title=res.team_name if res else None,
        date=res.date if res else None,
        start_time=res.start_time if res else None,
        end_time=res.end_time if res else None,
        room_name=res.room.name if res and res.room else None,
        memo=rec.memo, photos=list(rec.photos or []),
        attendees=[schemas.MeetupAttendeeOut.model_validate(a) for a in attendees],
        # parts 는 마이그레이션 전 행에서 NULL 일 수 있다 — photos 와 같이 빈 목록으로 받는다.
        songs=[schemas.MeetupSongOut(id=s.id, title=s.title, sort_order=s.sort_order,
                                     parts=list(s.parts or [])) for s in songs],
        attend_count=len(attendees),
        walk_in_count=len(walk_ins),
        free_count=len([a for a in attendees if a.pay_type == 'free']),
        walk_in_total=sum(a.fee for a in walk_ins),
        updated_at=rec.updated_at,
    )


@router.get("/api/admin/meetups", response_model=List[schemas.MeetupRecordOut])
def list_meetups(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    recs = _record_query(db).join(models.Reservation).order_by(
        models.Reservation.date.desc(), models.Reservation.start_time.desc()
    ).all()
    return [_view(r) for r in recs]


@router.get("/api/admin/meetups/slots", response_model=List[schemas.MeetupSlot])
def list_meetup_slots(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """아직 기록이 없는 정모 예약. 여기서 골라 기록을 만든다.
    정모는 미리 예약해두는 흐름이라 예약 없이 기록을 만들 일은 없다."""
    taken = {r[0] for r in db.query(models.MeetupRecord.reservation_id).all()}
    rows = db.query(models.Reservation).options(
        joinedload(models.Reservation.room)
    ).filter(
        models.Reservation.kind == 'meetup'
    ).order_by(models.Reservation.date.desc()).all()
    return [
        schemas.MeetupSlot(
            reservation_id=r.id, title=r.team_name, date=r.date,
            start_time=r.start_time, end_time=r.end_time,
            room_name=r.room.name if r.room else None,
        )
        for r in rows if r.id not in taken
    ]


@router.post("/api/admin/meetups/{reservation_id}", response_model=schemas.MeetupRecordOut)
def create_meetup_record(
    reservation_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    if res.kind != 'meetup':
        raise HTTPException(400, "정모 예약에만 기록을 남길 수 있습니다.")
    if db.query(models.MeetupRecord).filter(
        models.MeetupRecord.reservation_id == reservation_id
    ).first():
        raise HTTPException(400, "이미 기록이 있습니다.")

    rec = models.MeetupRecord(reservation_id=reservation_id, photos=[])
    db.add(rec)
    db.commit()
    log_event("meetup_record_created", id=rec.id, reservation_id=reservation_id,
              title=res.team_name, by=admin.username)
    audit(db, admin, "meetup.create", res.team_name, str(res.date), request)
    return _view(_record_query(db).filter(models.MeetupRecord.id == rec.id).first())


@router.put("/api/admin/meetups/{record_id}", response_model=schemas.MeetupRecordOut)
def save_meetup_record(
    record_id: int,
    data: schemas.MeetupRecordUpsert,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """참석자·곡을 통째로 갈아끼운다. 한 화면에서 같이 고치는 값이라
    항목별 API 를 두는 것보다 단순하고, 지운 줄이 남을 일이 없다."""
    rec = _record_query(db).filter(models.MeetupRecord.id == record_id).first()
    if not rec:
        raise HTTPException(404, "기록을 찾을 수 없습니다.")

    for photo in data.photos:
        if not photo.startswith('/uploads/'):
            raise HTTPException(400, "사진은 업로드된 파일만 쓸 수 있습니다.")

    rec.memo = (data.memo or '').strip() or None
    rec.photos = list(data.photos)

    rec.attendees.clear()
    for row in data.attendees:
        name = row.name.strip()
        if not name:
            continue
        rec.attendees.append(models.MeetupAttendee(
            member_id=row.member_id,
            name=name,
            pay_type=row.pay_type,
            # 당일 참가비일 때만 금액이 의미가 있다 — 나머지는 0 으로 눌러
            # 정산 합계에 엉뚱한 금액이 섞이지 않게 한다.
            fee=row.fee if row.pay_type == 'walk_in' else 0,
            memo=(row.memo or '').strip() or None,
        ))

    rec.songs.clear()
    for i, row in enumerate(data.songs):
        title = row.title.strip()
        if not title:
            continue
        rec.songs.append(models.MeetupSong(
            title=title,
            # 포지션·이름이 다 있는 줄만 남긴다 (빈 줄은 화면에서 그냥 지운 것)
            parts=[p.model_dump() for p in row.parts
                   if p.part.strip() and p.name.strip()],
            sort_order=i,
        ))

    db.commit()
    rec = _record_query(db).filter(models.MeetupRecord.id == record_id).first()
    out = _view(rec)
    log_event("meetup_record_saved", id=record_id, attendees=out.attend_count,
              songs=len(out.songs), walk_in=out.walk_in_total, by=admin.username)
    audit(db, admin, "meetup.save", out.title,
          f"참석 {out.attend_count}명 · 곡 {len(out.songs)}개 · 참가비 {out.walk_in_total:,}원",
          request)
    return out


@router.delete("/api/admin/meetups/{record_id}")
def delete_meetup_record(
    record_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    rec = _record_query(db).filter(models.MeetupRecord.id == record_id).first()
    if not rec:
        raise HTTPException(404, "기록을 찾을 수 없습니다.")
    title = rec.reservation.team_name if rec.reservation else str(record_id)
    db.delete(rec)
    db.commit()
    log_event("meetup_record_deleted", id=record_id, by=admin.username)
    audit(db, admin, "meetup.delete", title, request=request)
    return {"message": "삭제되었습니다."}


@router.post("/api/admin/meetups/upload")
async def upload_meetup_photo(
    file: UploadFile = File(...),
    admin: models.AdminUser = Depends(get_current_admin),
):
    """검사·저장 규칙은 uploads_util 한 곳에 있다 (티켓 배경과 공유)."""
    url, name, size = await save_image(file)
    log_event("meetup_photo_uploaded", file=name, size=size, by=admin.username)
    return {"url": url}
