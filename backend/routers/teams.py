from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session
from datetime import date
from typing import Dict, List, Optional, Tuple

from database import get_db
from app_logging import log_event
from deps import (
    get_current_admin, normalize_phone, clean_parts, audit, get_or_404,
    clean_http_url,
)
import models
import schemas

router = APIRouter(tags=["teams"])


def _team_response(t: models.Team, res_count: int = 0, member_count: int = 0,
                   ages: Tuple[Optional[float], Dict[str, int]] = (None, {}),
                   done_songs: int = 0) -> schemas.TeamResponse:
    # 컬럼이 늘어도 여기를 고치지 않도록 model_validate 로 받고 파생값만 얹는다.
    out = schemas.TeamResponse.model_validate(t)
    out.reservation_count = res_count
    out.member_count = member_count
    out.age_avg, out.age_buckets = ages
    out.done_song_count = done_songs
    return out


def _member_counts(db: Session) -> dict:
    """활동 중인 소속 인원. 한 사람이 여러 팀에 들어갈 수 있으므로 member_teams 를 센다."""
    return dict(
        db.query(models.MemberTeam.team_id, func.count(models.MemberTeam.member_id))
        .join(models.Member, models.Member.id == models.MemberTeam.member_id)
        .filter(models.Member.is_active == True)
        .group_by(models.MemberTeam.team_id).all()
    )


def _done_song_counts(db: Session) -> dict:
    """팀별 완곡 수. 멤버를 구할 때 "이 팀은 몇 곡을 올릴 수 있나" 가 목록에서 바로 보이게."""
    return dict(
        db.query(models.TeamSong.team_id, func.count(models.TeamSong.id))
        .filter(models.TeamSong.status == 'done')
        .group_by(models.TeamSong.team_id).all()
    )


def _age_stats(db: Session) -> dict:
    """팀별 (평균 나이, 연령대별 인원). 나이는 한국식 연 나이(올해 - 출생년도),
    연령대는 10년 단위이고 60 이상은 하나로 묶는다.
    출생년도를 모르는 멤버는 평균에도 연령대에도 들어가지 않는다 — 모르는 값을
    0살로 세면 평균이 통째로 무너진다."""
    this_year = date.today().year
    rows = (
        db.query(models.MemberTeam.team_id, models.Member.birth_year)
        .join(models.Member, models.Member.id == models.MemberTeam.member_id)
        .filter(models.Member.is_active == True,
                models.Member.birth_year.isnot(None))
        .all()
    )
    by_team: Dict[int, list] = {}
    for team_id, birth_year in rows:
        by_team.setdefault(team_id, []).append(this_year - birth_year)

    stats = {}
    for team_id, ages in by_team.items():
        buckets: Dict[str, int] = {}
        for age in ages:
            key = str(min(60, max(0, age) // 10 * 10))
            buckets[key] = buckets.get(key, 0) + 1
        stats[team_id] = (round(sum(ages) / len(ages), 1), buckets)
    return stats


def _apply_billing(team: models.Team, billing_type: str, monthly_fee, dues_fee, has_dues_fee=False):
    """과금 방식이 바뀌면 안 쓰는 금액은 비운다 — 나중에 되돌렸을 때
    예전 금액이 되살아나 잘못 청구되는 일을 막는다.

    dues_fee 는 관리 화면에 입력칸이 없어 폼이 값을 보내지 않는다.
    보내지 않았는데 지워버리면 이름만 고쳐도 팀 회비가 날아간다 —
    명시적으로 보냈을 때만 손댄다."""
    team.billing_type = billing_type
    team.monthly_fee = monthly_fee if billing_type == 'monthly' else None
    if billing_type != 'dues':
        team.dues_fee = None
    elif has_dues_fee:
        team.dues_fee = dues_fee


@router.get("/api/teams", response_model=List[schemas.TeamPublic])
def list_public_teams(db: Session = Depends(get_db)):
    """예약 페이지 드롭다운용. 활성 팀 이름만 노출."""
    return db.query(models.Team).filter(
        models.Team.is_active == True
    ).order_by(models.Team.name).all()


@router.get("/api/admin/teams", response_model=List[schemas.TeamResponse])
def list_teams(
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    teams = db.query(models.Team).order_by(models.Team.name).all()
    res_counts = dict(
        db.query(models.Reservation.team_id, func.count(models.Reservation.id))
        .filter(models.Reservation.team_id.isnot(None))
        .group_by(models.Reservation.team_id)
        .all()
    )
    member_counts = _member_counts(db)
    ages = _age_stats(db)
    songs = _done_song_counts(db)
    return [
        _team_response(t, res_counts.get(t.id, 0), member_counts.get(t.id, 0),
                       ages.get(t.id, (None, {})), songs.get(t.id, 0))
        for t in teams
    ]


@router.post("/api/admin/teams", response_model=schemas.TeamResponse)
def create_team(
    data: schemas.TeamCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    name = data.name.strip()
    if db.query(models.Team).filter(models.Team.name == name).first():
        raise HTTPException(400, "이미 등록된 팀 이름입니다.")
    team = models.Team(
        name=name,
        leader_name=(data.leader_name or '').strip() or None,
        phone=normalize_phone(data.phone),
        parts=clean_parts(data.parts),
        memo=(data.memo or '').strip() or None,
        is_doors=data.is_doors,
        is_active=data.is_active,
    )
    _apply_billing(team, data.billing_type, data.monthly_fee, data.dues_fee,
                   has_dues_fee='dues_fee' in data.model_fields_set)
    db.add(team)
    db.commit()
    db.refresh(team)
    log_event("team_created", id=team.id, name=team.name,
              billing=team.billing_type, by=admin.username)
    audit(db, admin, "team.create", team.name,
          f"과금 {team.billing_type}", request)
    return _team_response(team)


@router.patch("/api/admin/teams/{team_id}", response_model=schemas.TeamResponse)
def update_team(
    team_id: int,
    data: schemas.TeamUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    team = get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")

    fields = data.model_dump(exclude_unset=True)

    if fields.get('name'):
        name = fields['name'].strip()
        dup = db.query(models.Team).filter(
            models.Team.name == name, models.Team.id != team_id
        ).first()
        if dup:
            raise HTTPException(400, "이미 등록된 팀 이름입니다.")
        team.name = name
    for field in ('leader_name', 'memo'):
        if field in fields:
            setattr(team, field, (fields[field] or '').strip() or None)
    if 'phone' in fields:
        team.phone = normalize_phone(fields['phone'])
    if 'parts' in fields:
        team.parts = clean_parts(fields['parts'])
    for flag in ('is_active', 'is_doors'):
        if fields.get(flag) is not None:
            setattr(team, flag, fields[flag])

    if 'billing_type' in fields and fields['billing_type']:
        _apply_billing(
            team, fields['billing_type'],
            fields.get('monthly_fee', team.monthly_fee),
            fields.get('dues_fee', team.dues_fee),
            has_dues_fee='dues_fee' in fields,
        )
    else:
        if 'monthly_fee' in fields and team.billing_type == 'monthly':
            team.monthly_fee = fields['monthly_fee']
        if 'dues_fee' in fields and team.billing_type == 'dues':
            team.dues_fee = fields['dues_fee']

    db.commit()
    db.refresh(team)
    log_event("team_updated", id=team.id, name=team.name,
              billing=team.billing_type, by=admin.username)
    audit(db, admin, "team.update", team.name,
          "바꾼 항목: " + (", ".join(fields) or "없음"), request)
    res_count = db.query(models.Reservation).filter(models.Reservation.team_id == team.id).count()
    return _team_response(team, res_count, _member_counts(db).get(team.id, 0),
                          _age_stats(db).get(team.id, (None, {})),
                          _done_song_counts(db).get(team.id, 0))


# ========== 레퍼토리 ==========
# "이 팀이 어떤 곡을 할 수 있나" 를 보는 목록이라 완곡을 먼저 보여준다.
_STATUS_RANK = {'done': 0, 'practicing': 1, 'candidate': 2}


def _song_sort(songs):
    return sorted(songs, key=lambda s: (_STATUS_RANK.get(s.status, 9), s.title))


def _get_song(db: Session, song_id: int) -> models.TeamSong:
    return get_or_404(db, models.TeamSong, song_id, "곡을 찾을 수 없습니다.")


@router.get("/api/admin/teams/{team_id}/songs", response_model=List[schemas.SongResponse])
def list_songs(
    team_id: int,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")
    return _song_sort(db.query(models.TeamSong).filter(
        models.TeamSong.team_id == team_id
    ).all())


@router.post("/api/admin/teams/{team_id}/songs", response_model=schemas.SongResponse)
def create_song(
    team_id: int,
    data: schemas.SongCreate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    team = get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")
    song = models.TeamSong(
        team_id=team_id,
        title=data.title.strip(),
        artist=(data.artist or '').strip() or None,
        link=clean_http_url(data.link, "참고 링크"),
        memo=(data.memo or '').strip() or None,
        status=data.status,
    )
    db.add(song)
    db.commit()
    db.refresh(song)
    log_event("song_created", id=song.id, team=team.name, title=song.title,
              status=song.status, by=admin.username)
    audit(db, admin, "song.create", f"{team.name} · {song.title}",
          song.artist, request)
    return song


@router.patch("/api/admin/songs/{song_id}", response_model=schemas.SongResponse)
def update_song(
    song_id: int,
    data: schemas.SongUpdate,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    song = _get_song(db, song_id)
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "바꿀 내용이 없습니다.")

    if fields.get('title'):
        song.title = fields['title'].strip()
    for field in ('artist', 'memo'):
        if field in fields:
            setattr(song, field, (fields[field] or '').strip() or None)
    if 'link' in fields:
        song.link = clean_http_url(fields['link'], "참고 링크")
    if fields.get('status'):
        song.status = fields['status']

    db.commit()
    db.refresh(song)
    log_event("song_updated", id=song.id, title=song.title, status=song.status,
              fields=",".join(fields), by=admin.username)
    audit(db, admin, "song.update", f"{song.team.name} · {song.title}",
          "바꾼 항목: " + ", ".join(fields), request)
    return song


@router.delete("/api/admin/songs/{song_id}")
def delete_song(
    song_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    song = _get_song(db, song_id)
    label = f"{song.team.name} · {song.title}"
    db.delete(song)
    db.commit()
    log_event("song_deleted", id=song_id, by=admin.username)
    audit(db, admin, "song.delete", label, request=request)
    return {"message": "삭제되었습니다."}


@router.delete("/api/admin/teams/{team_id}")
def delete_team(
    team_id: int,
    request: Request,
    admin: models.AdminUser = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    team = get_or_404(db, models.Team, team_id, "팀을 찾을 수 없습니다.")
    used = db.query(models.Reservation).filter(models.Reservation.team_id == team_id).count()
    if used:
        raise HTTPException(
            400,
            f"예약 이력이 {used}건 있어 삭제할 수 없습니다. 비활성 처리해주세요.",
        )
    # 회비·이용료 기록은 팀과 함께 CASCADE 로 지워진다 — 정산 합계가 조용히 줄어든다.
    paid = db.query(models.TeamDues).filter(models.TeamDues.team_id == team_id).count() + \
        db.query(models.MemberDues).filter(models.MemberDues.team_id == team_id).count()
    if paid:
        raise HTTPException(
            400,
            f"회비·이용료 기록이 {paid}건 있어 삭제할 수 없습니다. 비활성 처리해주세요.",
        )
    members = db.query(models.MemberTeam).filter(
        models.MemberTeam.team_id == team_id
    ).count()
    if members:
        raise HTTPException(
            400,
            f"소속 멤버가 {members}명 있어 삭제할 수 없습니다. 멤버를 먼저 옮겨주세요.",
        )
    name = team.name
    db.delete(team)
    db.commit()
    log_event("team_deleted", id=team_id, name=name, by=admin.username)
    audit(db, admin, "team.delete", name, request=request)
    return {"message": "삭제되었습니다."}
