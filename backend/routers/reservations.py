from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from datetime import date, datetime, time, timedelta
from typing import List, Optional
import asyncio
import logging
import secrets

from database import get_db
from broadcaster import broadcaster
from app_logging import log_event
from deps import (
    get_current_admin, normalize_phone, member_dues_ok, audit, get_or_404, rate_limit,
)
import models
import schemas

router = APIRouter(tags=["reservations"])


# 24시간 운영이라 자정에 끝나는 예약(23:00~24:00)이 정상이다.
# 종료 시각 00:00 은 '다음날 0시'가 아니라 '그날 24시'를 뜻하므로
# 비교할 때만 1440분으로 바꿔 쓴다. 시작 시각에는 이 규칙을 적용하지 않는다.
DAY_MINUTES = 24 * 60


def _mins(t) -> int:
    return t.hour * 60 + t.minute


def _end_mins(t) -> int:
    m = _mins(t)
    return DAY_MINUTES if m == 0 else m


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    """[a_start, a_end) 와 [b_start, b_end) 가 겹치는지. 모두 분 단위."""
    return not (a_end <= b_start or a_start >= b_end)


def _split_by_day(start_dt: datetime, end_dt: datetime):
    """자정을 넘기는 구간을 날짜별로 쪼갠다.
    23:00~다음날 02:00 -> [(그날, 23:00, 00:00, 1h), (다음날, 00:00, 02:00, 2h)]
    종료가 자정 정각이면 쪼개지 않는다 (그날 24시로 본다)."""
    segments = []
    cursor = start_dt
    while cursor < end_dt:
        midnight = datetime.combine(cursor.date(), time(0, 0)) + timedelta(days=1)
        seg_end = min(end_dt, midnight)
        segments.append({
            "date": cursor.date(),
            "start": cursor.time(),
            "end": seg_end.time(),          # 자정이면 00:00 = 그날 24시
            "hours": (seg_end - cursor).total_seconds() / 3600,
        })
        cursor = seg_end
    return segments


def _group_rows(db: Session, res: models.Reservation):
    """자정을 넘겨 나뉜 예약이면 짝을 모두, 아니면 자기 자신만."""
    if not res.group_key:
        return [res]
    return db.query(models.Reservation).filter(
        models.Reservation.group_key == res.group_key
    ).order_by(models.Reservation.date, models.Reservation.start_time).all()


def _assert_slots_free(db: Session, room_id: int, segments, request, who=None,
                       exclude_ids=()):
    """나뉜 구간을 각각 검사한다 — 한 구간이라도 막히면 전체를 거부한다.
    생성과 수정이 같은 규칙을 써야 하므로 한 곳에 모아 둔다.
    exclude_ids 는 수정 중인 예약 자기 자신 — 자기 시간과 겹친다고 거부하면 안 된다."""
    skip = set(exclude_ids)
    # 같은 방 예약을 커밋까지 한 줄로 세운다 — 검사와 저장 사이에 다른 요청이 끼면 이중 예약이 된다.
    db.query(models.Room).filter(models.Room.id == room_id).with_for_update().first()
    for seg in segments:
        seg_start, seg_end = _mins(seg["start"]), _end_mins(seg["end"])

        for r in db.query(models.Reservation).filter(
            models.Reservation.room_id == room_id,
            models.Reservation.date == seg["date"],
        ).all():
            if r.id in skip:
                continue
            if _overlaps(seg_start, seg_end, _mins(r.start_time), _end_mins(r.end_time)):
                log_event(
                    "reservation_conflict",
                    level=logging.WARNING,
                    client=request.client.host if request.client else None,
                    room_id=room_id,
                    date=str(seg["date"]),
                    start=str(seg["start"]),
                    end=str(seg["end"]),
                    team=who,
                )
                raise HTTPException(400, "해당 시간에 이미 예약이 있습니다.")

        for b in db.query(models.BlockedPeriod).filter(
            models.BlockedPeriod.date == seg["date"],
        ).all():
            if b.room_id is not None and b.room_id != room_id:
                continue
            if b.start_time is None or b.end_time is None:
                overlaps = True
            else:
                overlaps = _overlaps(seg_start, seg_end, _mins(b.start_time), _end_mins(b.end_time))
            if overlaps:
                log_event(
                    "reservation_blocked",
                    level=logging.WARNING,
                    client=request.client.host if request.client else None,
                    room_id=room_id,
                    date=str(seg["date"]),
                    start=str(seg["start"]),
                    end=str(seg["end"]),
                    blocked_id=b.id,
                    reason=b.reason,
                )
                msg = "해당 시간은 예약이 차단되어 있습니다."
                if b.reason:
                    msg += f" ({b.reason})"
                raise HTTPException(400, msg)


OVERNIGHT_END = 6   # 이용자 예약은 다음날 이 시각까지 — app.js · guide.js 와 같은 값


def _split_segments(day, start_time, duration: float):
    """시작 시각 + 시간 수 를 날짜별 구간으로. 자정을 넘기면 두 건이 된다."""
    # 30분 단위 예약 — duration 은 스키마가 0.5 배수로 막고, 시작 시각은 여기서 막는다.
    if start_time.minute % 30 or start_time.second or start_time.microsecond:
        raise HTTPException(400, "시작 시각은 30분 단위여야 합니다.")
    start_dt = datetime.combine(day, start_time)
    segments = _split_by_day(start_dt, start_dt + timedelta(hours=duration))
    if len(segments) > 2:
        raise HTTPException(400, "예약은 하루를 넘겨 이틀까지만 가능합니다.")
    return segments


def _sse_payload(r: models.Reservation) -> dict:
    """SSE 로 내보내는 예약 요약. 세 곳에서 같은 모양을 만들던 것을 모았다."""
    return {
        "id": r.id,
        "room_id": r.room_id,
        "date": str(r.date),
        "start_time": str(r.start_time),
        "end_time": str(r.end_time),
        # SSE 도 인증 없는 공개 스트림이다 — 개인연습실 실명은 공개 목록처럼 가린다.
        "team_name": schemas.mask_name(r.team_name) if r.kind == 'personal' else r.team_name,
        "status": r.status,
    }


@router.get("/api/rooms", response_model=List[schemas.Room])
def get_rooms(db: Session = Depends(get_db)):
    return db.query(models.Room).order_by(models.Room.id).all()


def _reservation_query(db: Session, date, room_id, team_id):
    query = db.query(models.Reservation)
    if date:
        query = query.filter(models.Reservation.date == date)
    if room_id:
        query = query.filter(models.Reservation.room_id == room_id)
    if team_id:
        query = query.filter(models.Reservation.team_id == team_id)
    return query.order_by(models.Reservation.date, models.Reservation.start_time).all()


@router.get("/api/reservations", response_model=List[schemas.ReservationPublic])
def get_reservations(
    date: Optional[str] = None,
    room_id: Optional[int] = None,
    team_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """예약 페이지 타임라인용. 인증이 없으므로 개인정보는 빼고 보낸다
    (ReservationPublic). 관리자 화면은 아래 /api/admin/reservations 를 쓴다."""
    return _reservation_query(db, date, room_id, team_id)


@router.get("/api/admin/reservations", response_model=List[schemas.ReservationResponse])
def get_reservations_admin(
    date: Optional[str] = None,
    room_id: Optional[int] = None,
    team_id: Optional[int] = None,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """연락처·메모까지 전부. 공개 목록과 같은 쿼리를 쓴다."""
    return _reservation_query(db, date, room_id, team_id)


@router.get("/api/reservations/stream")
async def reservations_stream(request: Request):
    queue = await broadcaster.subscribe()

    async def event_gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield {"data": msg}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            await broadcaster.unsubscribe(queue)

    return EventSourceResponse(event_gen())


def find_member_by_name(db: Session, name: str):
    """이름으로 활동 중인 멤버를 찾는다.
    반환: (member, ambiguous). 동명이인이면 (None, True) — 잘못된 사람에게
    무료 이용을 붙이는 것보다 막고 관리자가 정리하는 편이 안전하다."""
    cleaned = (name or '').strip()
    if not cleaned:
        return None, False
    matches = db.query(models.Member).filter(
        models.Member.name == cleaned,
        models.Member.is_active == True,
    ).all()
    if len(matches) == 1:
        return matches[0], False
    if len(matches) > 1:
        return None, True
    return None, False


@router.post("/api/members/check", response_model=schemas.MemberCheckResponse)
def check_member(data: schemas.MemberCheckRequest, db: Session = Depends(get_db)):
    """예약 페이지에서 이름을 입력했을 때 요금이 어떻게 되는지 미리 알려준다."""
    member, ambiguous = find_member_by_name(db, data.name)
    if ambiguous:
        return schemas.MemberCheckResponse(
            ambiguous=True,
            message="같은 이름의 멤버가 여러 명입니다. 문의하기로 접수해주세요.",
        )
    if not member:
        return schemas.MemberCheckResponse(message="게스트로 예약됩니다. 시간당 요금이 적용됩니다.")

    # 예약하려는 달의 회비를 본다 — 예약 생성 때와 같은 기준이어야 한다.
    ym = (data.date or date.today()).strftime('%Y-%m')
    ok = member_dues_ok(db, member, ym)
    return schemas.MemberCheckResponse(
        is_member=True,
        dues_ok=ok,
        message="회비 납부가 확인되었습니다. 무료로 이용하실 수 있습니다."
        if ok else "이번 달 회비가 확인되지 않아 시간당 요금이 적용됩니다.",
    )


@router.post("/api/reservations", response_model=schemas.ReservationCreated)
def create_reservation(
    reservation: schemas.ReservationCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    rate_limit(request, "reservation", 20)
    room = db.query(models.Room).filter(models.Room.id == reservation.room_id).first()
    if not room:
        raise HTTPException(400, "존재하지 않는 공간입니다.")

    team = None
    member = None
    open_jam = None
    booker_name = None
    booker_phone = None
    free = False   # 요금 없이 바로 확정할지

    if room.booking_mode == 'personal':
        # 개인연습실 — 팀이 아니라 멤버 본인이나 게스트가 쓴다.
        booker_name = (reservation.booker_name or '').strip()
        if not booker_name:
            raise HTTPException(400, "이용자 이름을 입력해주세요.")

        member, ambiguous = find_member_by_name(db, booker_name)
        if ambiguous:
            raise HTTPException(400, "같은 이름의 멤버가 여러 명입니다. 문의하기로 접수해주세요.")

        booker_phone = normalize_phone(reservation.booker_phone)
        if member:
            free = member_dues_ok(db, member, reservation.date.strftime('%Y-%m'))
        elif not booker_phone:
            # 게스트는 연락이 닿아야 입금 확인을 할 수 있다.
            raise HTTPException(400, "게스트 예약은 연락처가 필요합니다.")
    elif reservation.jam_id is not None:
        # 오픈 잼으로 잡는 예약. 팀이 아니므로 대관·정모와 같은 길을 탄다 —
        # 표시 이름만 갖고 회비·정산과는 무관하다.
        jam = db.query(models.OpenJam).filter(
            models.OpenJam.id == reservation.jam_id
        ).first()
        if not jam or jam.status != 'closed':
            raise HTTPException(400, "모집이 마감된 오픈 잼만 예약할 수 있습니다.")
        open_jam = jam
        # 참여자 전원이 이미 월회비를 내는 도어즈 회원이라 건별 요금이 없다.
        free = True
    else:
        team = db.query(models.Team).filter(models.Team.id == reservation.team_id).first()
        if not team or not team.is_active:
            raise HTTPException(400, "등록되지 않은 팀입니다. 문의하기로 팀 등록을 요청해주세요.")
        free = not team.is_hourly

    # 자정을 넘기면 거부하지 않고 날짜별로 쪼갠다 (23시~새벽 2시 같은 예약).
    segments = _split_segments(reservation.date, reservation.start_time, reservation.duration)
    if len(segments) > 1 and segments[-1]["end"] > time(OVERNIGHT_END):
        raise HTTPException(400, f"자정을 넘긴 예약은 다음날 {OVERNIGHT_END}시까지만 가능합니다.")

    display = team.name if team else (
        f"[오픈잼] {open_jam.title}" if open_jam else booker_name)
    _assert_slots_free(db, reservation.room_id, segments, request, who=display)

    # 나뉜 예약도 사용자에겐 한 건이다 — group_key 로 묶어 함께 확정·취소한다.
    group_key = secrets.token_hex(8) if len(segments) > 1 else None
    # 신청한 본인만 취소할 수 있게 하는 열쇠. 나뉜 예약은 같은 열쇠를 나눠 갖는다.
    cancel_token = secrets.token_hex(16)
    created = []
    for seg in segments:
        row = models.Reservation(
            room_id=reservation.room_id,
            team_id=team.id if team else None,
            member_id=member.id if member else None,
            booker_name=booker_name,
            booker_phone=booker_phone,
            date=seg["date"],
            start_time=seg["start"],
            end_time=seg["end"],
            duration=seg["hours"],
            team_name=display,
            # 개인연습실은 혼자 쓴다 — 이 칸에 연락처를 적는 일이 있어 아예 받지 않는다.
            members=None if room.booking_mode == 'personal' else reservation.members,
            note=reservation.note,
            # 낼 것이 없는 예약(선불 팀 · 회비 낸 멤버)은 입금 확인 단계를 건너뛴다.
            kind=('personal' if room.booking_mode == 'personal'
                  else 'openjam' if open_jam else 'team'),
            is_free=free,
            status='confirmed' if free else 'pending',
            group_key=group_key,
            cancel_token=cancel_token,
        )
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
        broadcaster.publish("reservation_created", _sse_payload(row))

    db_r = created[0]
    log_event(
        "reservation_created",
        id=db_r.id,
        room_id=db_r.room_id,
        date=str(db_r.date),
        start=str(db_r.start_time),
        end=str(created[-1].end_time),
        team=db_r.team_name,
        member_id=db_r.member_id,
        segments=len(created),
        status=db_r.status,
        client=request.client.host if request.client else None,
    )
    return db_r


@router.post("/api/reservations/{reservation_id}/confirm", response_model=schemas.ReservationResponse)
def confirm_reservation(
    reservation_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    if res.status == 'confirmed':
        raise HTTPException(400, "이미 확정된 예약입니다.")

    rows = _group_rows(db, res)
    for row in rows:
        row.status = 'confirmed'
    db.commit()
    for row in rows:
        db.refresh(row)
        broadcaster.publish("reservation_confirmed", _sse_payload(row))
    log_event(
        "reservation_confirmed",
        id=res.id,
        room_id=res.room_id,
        date=str(res.date),
        team=res.team_name,
        by=admin.username,
    )
    audit(db, admin, "reservation.confirm", res.team_name,
          f"{res.date} {res.start_time}~{res.end_time}", request)
    return res


ADMIN_KIND_KO = {'rental': '장소 대관', 'meetup': '도어즈 정모'}


@router.post("/api/admin/reservations", response_model=schemas.ReservationResponse)
def create_admin_reservation(
    data: schemas.AdminReservationCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """장소 대관 · 도어즈 정모. 팀이 아니라 이름만 적는다.

    이용자 예약과 같은 표(reservations)에 담아 자정 넘김 분할 · 겹침 검사 ·
    수정 · 취소 · 실시간 갱신을 그대로 쓴다. 표시 이름은 team_name 에 넣는다 —
    화면들이 이미 그 칸을 읽고 있어서 목록·타임라인·캘린더를 안 고쳐도 이름이 나온다."""
    room = db.query(models.Room).filter(models.Room.id == data.room_id).first()
    if not room:
        raise HTTPException(400, "존재하지 않는 공간입니다.")

    title = data.title.strip()
    segments = _split_segments(data.date, data.start_time, data.duration)
    _assert_slots_free(db, data.room_id, segments, request, who=title)

    group_key = secrets.token_hex(8) if len(segments) > 1 else None
    created = []
    for seg in segments:
        row = models.Reservation(
            room_id=data.room_id,
            date=seg["date"],
            start_time=seg["start"],
            end_time=seg["end"],
            duration=seg["hours"],
            team_name=title,
            booker_phone=normalize_phone(data.contact_phone),
            note=data.note,
            kind=data.kind,
            # 관리자가 직접 만든 예약이라 입금 확인 단계가 없다.
            is_free=True,
            status='confirmed',
            group_key=group_key,
        )
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
        broadcaster.publish("reservation_created", _sse_payload(row))

    first = created[0]
    log_event("admin_reservation_created", id=first.id, kind=data.kind,
              room_id=data.room_id, date=str(first.date), title=title,
              segments=len(created), by=admin.username)
    audit(db, admin, "reservation.admin_create", title,
          f"{ADMIN_KIND_KO.get(data.kind, data.kind)} · {first.date} "
          f"{first.start_time}~{created[-1].end_time}", request)
    return first


@router.patch("/api/admin/reservations/{reservation_id}",
              response_model=schemas.ReservationResponse)
def update_reservation(
    reservation_id: int,
    data: schemas.ReservationAdminUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """수정 요청이 들어왔을 때 관리자가 시간·공간·예약자를 고친다.

    자정을 넘기면 예약이 날짜별 두 건으로 나뉘어 있고, 고치면 몇 건으로 나뉠지가
    또 달라진다. 그래서 그룹을 통째로 다시 만든다 — 상태·무료 여부·취소 토큰은
    그대로 물려줘서 이용자 쪽 취소 버튼이 살아 있게 한다."""
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    rows = _group_rows(db, res)
    old_ids = [r.id for r in rows]
    # 옮기거나 줄이면 옛 날짜를 보던 화면도 새로고침해야 한다.
    old_payloads = [{"id": r.id, "room_id": r.room_id, "date": str(r.date)} for r in rows]
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "바꿀 내용이 없습니다.")

    first, last = rows[0], rows[-1]
    room_id = fields.get('room_id', first.room_id)
    room = db.query(models.Room).filter(models.Room.id == room_id).first()
    if not room:
        raise HTTPException(400, "존재하지 않는 공간입니다.")

    day = fields.get('date', first.date)
    start_time = fields.get('start_time', first.start_time)
    duration = fields.get('duration', sum(r.duration for r in rows))

    # 예약자 — 공간 종류에 따라 팀이거나 개인이다 (생성 때와 같은 규칙).
    team = first.team
    member = first.member
    booker_name = fields.get('booker_name', first.booker_name)
    booker_phone = normalize_phone(fields['booker_phone']) if 'booker_phone' in fields \
        else first.booker_phone

    # 종류는 만들 때 정해지고 바뀌지 않는다. 대관·정모는 팀도 이용자도 없이 이름만 갖는다.
    if first.kind in ADMIN_KIND_KO or first.kind == 'openjam':
        display = (fields.get('title') or first.team_name or '').strip()
        if not display:
            raise HTTPException(400, "이름을 입력해주세요.")
        team, member, booker_name = None, None, None
    elif room.booking_mode == 'personal':
        booker_name = (booker_name or '').strip()
        if not booker_name:
            raise HTTPException(400, "이용자 이름을 입력해주세요.")
        if 'booker_name' in fields or 'room_id' in fields:
            member, ambiguous = find_member_by_name(db, booker_name)
            if ambiguous:
                raise HTTPException(400, "같은 이름의 멤버가 여러 명입니다.")
        team = None
        display = booker_name
    else:
        if 'team_id' in fields:
            team = db.query(models.Team).filter(
                models.Team.id == fields['team_id']
            ).first()
            if not team:
                raise HTTPException(400, "등록되지 않은 팀입니다.")
        if team is None:
            raise HTTPException(400, "예약 팀을 지정해주세요.")
        member, booker_name, booker_phone = None, None, None
        display = team.name

    segments = _split_segments(day, start_time, duration)
    # 자기 자신과 겹친다고 막으면 메모만 고쳐도 거부된다.
    _assert_slots_free(db, room_id, segments, request, who=display, exclude_ids=old_ids)

    before = (f"{first.date} {first.start_time}~{last.end_time} "
              f"{first.room.name} {first.team_name}")

    # 상태와 무료 여부는 그대로 간다: 관리자가 시간을 옮겼다고 입금이 취소되는 건 아니다.
    # 취소 토큰도 유지해야 이용자 쪽 취소 버튼이 계속 살아 있다.
    members = fields.get('members', first.members)
    note = fields.get('note', first.note)
    kind = first.kind
    # 자정을 넘기느냐에 따라 한 건이 되기도 두 건이 되기도 한다.
    group_key = secrets.token_hex(8) if len(segments) > 1 else None

    # 있는 행을 고쳐 쓴다 — 지웠다 다시 만들면 id 가 바뀌어서
    # 이 id 를 들고 있던 화면과 링크가 전부 어긋난다.
    kept = []
    for i, seg in enumerate(segments):
        row = rows[i] if i < len(rows) else models.Reservation(
            is_free=first.is_free, status=first.status,
            cancel_token=first.cancel_token, kind=kind,
        )
        row.room_id = room_id
        row.team_id = team.id if team else None
        row.member_id = member.id if member else None
        row.booker_name = booker_name
        row.booker_phone = booker_phone
        row.date = seg["date"]
        row.start_time = seg["start"]
        row.end_time = seg["end"]
        row.duration = seg["hours"]
        row.team_name = display
        row.members = members
        row.note = note
        row.group_key = group_key
        row.kind = kind
        if i >= len(rows):
            db.add(row)
        kept.append(row)

    # 자정을 안 넘기게 줄이면 뒷 조각은 사라진다.
    for row in rows[len(segments):]:
        db.delete(row)
    db.commit()

    for payload in old_payloads:
        broadcaster.publish("reservation_deleted", payload)
    for row in kept:
        db.refresh(row)
        broadcaster.publish("reservation_created", _sse_payload(row))
    created = kept

    after = (f"{created[0].date} {created[0].start_time}~{created[-1].end_time} "
             f"{room.name} {display}")
    log_event("reservation_updated", id=created[0].id, ids=",".join(map(str, old_ids)),
              room_id=room_id, date=str(created[0].date), team=display,
              fields=",".join(fields), by=admin.username)
    audit(db, admin, "reservation.update", display, f"{before} → {after}", request)
    return created[0]


@router.post("/api/reservations/{reservation_id}/cancel")
def cancel_reservation(
    reservation_id: int,
    data: schemas.ReservationCancel,
    request: Request,
    db: Session = Depends(get_db),
):
    """예약한 본인이 취소한다. 로그인이 없으므로 생성 때 발급한 토큰이 신분증이다.
    토큰이 없으면 남의 예약도 id 만으로 지워지므로 절대 생략하면 안 된다."""
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    # compare_digest 로 맞춘다 — 글자 수 비교로 토큰을 조금씩 알아내지 못하게.
    if not res.cancel_token or not secrets.compare_digest(res.cancel_token.encode(), data.token.encode()):
        raise HTTPException(403, "이 예약을 취소할 권한이 없습니다.")

    rows = _group_rows(db, res)
    # 나뉜 예약은 첫 조각의 시작 시각이 기준이다.
    first = rows[0]
    if datetime.combine(first.date, first.start_time) <= datetime.now():
        raise HTTPException(400, "이미 시작된 예약은 취소할 수 없습니다. 문의로 연락해주세요.")

    payloads = [{"id": r.id, "room_id": r.room_id, "date": str(r.date)} for r in rows]
    team = res.team_name
    audit(db, None, "reservation.cancel", team,
          "이용자 본인 취소 · " +
          " / ".join(f"{r.date} {r.start_time}~{r.end_time}" for r in rows), request)
    for row in rows:
        db.delete(row)
    db.commit()
    for payload in payloads:
        broadcaster.publish("reservation_deleted", payload)
        log_event(
            "reservation_cancelled",
            id=payload["id"],
            room_id=payload["room_id"],
            date=payload["date"],
            team=team,
            by="self",
            client=request.client.host if request.client else None,
        )
    return {"message": "취소되었습니다."}


@router.delete("/api/reservations/{reservation_id}")
def delete_reservation(
    reservation_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    res = get_or_404(db, models.Reservation, reservation_id, "예약을 찾을 수 없습니다.")
    rows = _group_rows(db, res)
    payloads = [{"id": r.id, "room_id": r.room_id, "date": str(r.date)} for r in rows]
    team = res.team_name
    audit(db, admin, "reservation.delete", team,
          " / ".join(f"{r.date} {r.start_time}~{r.end_time}" for r in rows), request)
    for row in rows:
        db.delete(row)
    db.commit()
    for payload in payloads:
        broadcaster.publish("reservation_deleted", payload)
        log_event(
            "reservation_deleted",
            id=payload["id"],
            room_id=payload["room_id"],
            date=payload["date"],
            team=team,
            by=admin.username,
        )
    return {"message": "취소되었습니다."}
