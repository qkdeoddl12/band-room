from sqlalchemy import (
    Column, Integer, String, Date, Time, Text, DateTime, ForeignKey, Boolean,
    JSON, UniqueConstraint, Float,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Room(Base):
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    hourly_price = Column(Integer, nullable=False, server_default='0')
    # 3시간 이상 예약이면 시간당 이 요금으로 계산한다. NULL 이면 할인 없음
    long_hourly_price = Column(Integer)
    # 'team'     = 등록된 팀이 예약 (합주실)
    # 'personal' = 멤버 본인 또는 게스트가 예약 (개인연습실)
    booking_mode = Column(String(20), nullable=False, server_default='team')
    reservations = relationship("Reservation", back_populates="room")


class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False, index=True)
    leader_name = Column(String(50))
    phone = Column(String(30))
    parts = Column(String(200))  # 팀 구성 포지션. 멤버와 같은 콤마 문자열
    memo = Column(Text)
    # 'hourly'  = 이용할 때마다 시간당 결제
    # 'monthly' = 팀이 월 이용료를 한 번에 납부 (monthly_fee)
    # 'dues'    = 팀 멤버가 각자 월회비 납부 (dues_fee, 멤버별 금액이 우선)
    billing_type = Column(String(20), nullable=False, server_default='hourly')
    monthly_fee = Column(Integer)   # billing_type='monthly' 일 때 팀 월 이용료
    dues_fee = Column(Integer)      # billing_type='dues' 일 때 이 팀의 1인 기본 회비
    # 도어즈 소속 밴드인가, 외부 밴드인가. 멤버의 is_doors 와 같은 뜻이고
    # 과금 방식(billing_type)과는 별개다 — 외부 밴드도 월 이용료를 낼 수 있다.
    is_doors = Column(Boolean, nullable=False, server_default='true')
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    members = relationship("Member", back_populates="team")
    dues = relationship("TeamDues", back_populates="team", cascade="all, delete-orphan")
    songs = relationship("TeamSong", back_populates="team", cascade="all, delete-orphan")

    @property
    def is_hourly(self) -> bool:
        return self.billing_type == 'hourly'


class TeamSong(Base):
    """팀 레퍼토리. '이 팀이 어떤 곡을 할 수 있나' 를 보는 목록이라
    목록은 완곡 → 연습중 → 후보 순으로 보여준다 (routers/teams.py::_song_sort)."""
    __tablename__ = "team_songs"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    title = Column(String(200), nullable=False)
    artist = Column(String(100))
    # 화면에서 href 로 나가므로 http/https 만 통과시킨다 (deps.clean_http_url)
    link = Column(String(500))
    memo = Column(Text)
    # 'candidate' 후보 | 'practicing' 연습중 | 'done' 완곡
    status = Column(String(20), nullable=False, server_default='candidate')
    created_at = Column(DateTime, server_default=func.now())

    team = relationship("Team", back_populates="songs")


class Reservation(Base):
    __tablename__ = "reservations"

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"))
    date = Column(Date, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    duration = Column(Float, nullable=False)   # 시간 단위, 30분 = 0.5
    team_name = Column(String(200))  # snapshot of team.name at booking time
    # 개인연습실 예약용. member_id 가 있으면 우리 멤버, 없으면 게스트.
    member_id = Column(Integer, ForeignKey("members.id"))
    booker_name = Column(String(50))
    booker_phone = Column(String(30))
    members = Column(Text)
    note = Column(Text)
    status = Column(String(20), nullable=False, server_default='pending')
    # 자정을 넘기는 예약은 날짜별 두 건으로 나눠 저장하고 같은 group_key 로 묶는다.
    # 확정·취소는 짝을 함께 처리한다.
    group_key = Column(String(32), index=True)
    # 무엇을 위한 예약인가. 팀·개인은 이용자가 만들고, 대관·정모는 관리자가 만든다.
    # 'team' 팀 합주 | 'personal' 개인연습실 | 'rental' 장소 대관 | 'meetup' 도어즈 정모
    kind = Column(String(20), nullable=False, server_default='team', index=True)
    # 본인 취소용. 로그인이 없으므로 '이 예약을 신청한 브라우저' 를 이 토큰으로 가린다.
    # 절대 공개 목록에 실으면 안 된다 — 생성 응답에서만 한 번 내보낸다.
    # 자정을 넘겨 나뉜 예약은 group_key 처럼 같은 토큰을 공유한다.
    cancel_token = Column(String(32), index=True)
    # 예약 시점의 과금 판정을 그대로 남긴다. 나중에 팀 과금 방식이나 회비 상태가
    # 바뀌어도 지난 예약의 요금이 따라 바뀌지 않게.
    is_free = Column(Boolean, nullable=False, server_default='false')
    created_at = Column(DateTime, server_default=func.now())

    room = relationship("Room", back_populates="reservations")
    team = relationship("Team")
    member = relationship("Member")


class OpenJam(Base):
    """오픈 잼 — 1곡 단위로 발제해 포지션별 선착순으로 사람을 모으는 단기 프로젝트.
    팀이 아니다 (teams 에 만들지 않는다) — 회비가 소속 팀마다 청구되므로
    팀으로 만들면 참여자에게 회비가 한 건 더 붙는다."""
    __tablename__ = "open_jams"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)          # "아이유 - 밤편지"
    leader_member_id = Column(Integer, ForeignKey("members.id", ondelete="SET NULL"))
    leader_name = Column(String(50))                     # 멤버가 지워져도 남는 스냅샷
    target_period = Column(String(100))                  # "10월 셋째 주" — 날짜가 아니다
    memo = Column(Text)
    # 'recruiting' 모집중 | 'closed' 모집완료 | 'done' 종료
    status = Column(String(20), nullable=False, server_default='recruiting', index=True)
    # 모집을 마감한 시각. "합주 끝났는데 아무도 종료를 안 눌렀다"를 세는 기준이다
    # (발제일이 아니라 마감일부터 세야 모집 기간이 안 섞인다).
    closed_at = Column(DateTime)
    # 발제자용. 목록에 절대 싣지 않는다 — 실으면 남의 잼을 마감·삭제할 수 있다.
    manage_token = Column(String(32))
    created_at = Column(DateTime, server_default=func.now())

    leader = relationship("Member")
    slots = relationship("OpenJamSlot", back_populates="jam",
                         cascade="all, delete-orphan")


class OpenJamSlot(Base):
    """모집 포지션 한 자리. '보컬1, 통기타1, 건반1' 은 슬롯 세 개다 —
    자리 단위로 두면 선착순이 그대로 '빈 자리 잡기'가 된다."""
    __tablename__ = "open_jam_slots"

    id = Column(Integer, primary_key=True, index=True)
    jam_id = Column(Integer, ForeignKey("open_jams.id", ondelete="CASCADE"),
                    nullable=False, index=True)
    part = Column(String(50), nullable=False)
    sort_order = Column(Integer, nullable=False, server_default='0')
    member_id = Column(Integer, ForeignKey("members.id", ondelete="SET NULL"))
    member_name = Column(String(50))
    claim_token = Column(String(32))
    claimed_at = Column(DateTime)

    jam = relationship("OpenJam", back_populates="slots")
    member = relationship("Member")


class MeetupRecord(Base):
    """정모 기록. 예약(kind='meetup') 한 건에 하나 붙는다 —
    날짜·장소는 예약이 이미 갖고 있어서 다시 적지 않는다."""
    __tablename__ = "meetup_records"

    id = Column(Integer, primary_key=True, index=True)
    reservation_id = Column(Integer, ForeignKey("reservations.id", ondelete="CASCADE"),
                            nullable=False, unique=True, index=True)
    memo = Column(Text)
    # 업로드된 사진 주소 배열. 파일 자체는 uploads/ 에 있고 여기엔 경로만 담는다.
    photos = Column(JSON, nullable=False, server_default='[]')
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    reservation = relationship("Reservation")
    attendees = relationship("MeetupAttendee", back_populates="record",
                             cascade="all, delete-orphan")
    songs = relationship("MeetupSong", back_populates="record",
                         cascade="all, delete-orphan")


class MeetupAttendee(Base):
    """정모 참석자. 도어즈 멤버면 member_id 가 있고, 외부 게스트는 이름만 있다."""
    __tablename__ = "meetup_attendees"

    id = Column(Integer, primary_key=True, index=True)
    record_id = Column(Integer, ForeignKey("meetup_records.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    member_id = Column(Integer, ForeignKey("members.id", ondelete="SET NULL"))
    name = Column(String(50), nullable=False)   # 멤버가 지워져도 남는 스냅샷
    # 'dues' 월회비로 참석 | 'walk_in' 당일 참가비 | 'free' 무료 참관
    pay_type = Column(String(20), nullable=False, server_default='dues')
    # walk_in 일 때만 의미가 있다. 정산의 세 번째 수입으로 합산된다.
    fee = Column(Integer, nullable=False, server_default='0')
    memo = Column(String(200))

    record = relationship("MeetupRecord", back_populates="attendees")
    member = relationship("Member")


class MeetupSong(Base):
    """그날 합주한 곡. parts 는 [{part, name, member_id}] 목록으로,
    참석 명단에서 고른 사람을 포지션에 붙인 것이다. 이름은 스냅샷이라
    멤버를 지워도 기록이 남는다 (예약 team_name 과 같은 이유)."""
    __tablename__ = "meetup_songs"

    id = Column(Integer, primary_key=True, index=True)
    record_id = Column(Integer, ForeignKey("meetup_records.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    title = Column(String(200), nullable=False)
    parts = Column(JSON, default=list)
    sort_order = Column(Integer, nullable=False, server_default='0')

    record = relationship("MeetupRecord", back_populates="songs")


class AdminUser(Base):
    __tablename__ = "admin_users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(200), nullable=False)
    role = Column(String(20), nullable=False)  # 'system' or 'reservation'
    is_active = Column(Boolean, default=True, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    sessions = relationship("AdminSession", back_populates="user", cascade="all, delete-orphan")


class AdminSession(Base):
    __tablename__ = "admin_sessions"

    token = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False)
    expires_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())

    user = relationship("AdminUser", back_populates="sessions")


class Inquiry(Base):
    __tablename__ = "inquiries"

    id = Column(Integer, primary_key=True, index=True)
    category = Column(String(20), nullable=False)  # 'question' | 'complaint' | 'incident'
    content = Column(Text, nullable=False)
    contact_name = Column(String(100))
    contact_phone = Column(String(30))
    status = Column(String(20), nullable=False, server_default='new', index=True)  # 'new' | 'resolved'
    resolved_by = Column(String(50))
    resolved_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())


class BlockedPeriod(Base):
    __tablename__ = "blocked_periods"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, index=True)
    start_time = Column(Time)  # null = all day
    end_time = Column(Time)    # null = all day
    room_id = Column(Integer, ForeignKey("rooms.id"))  # null = all rooms
    reason = Column(String(200))
    created_by = Column(String(50))
    created_at = Column(DateTime, server_default=func.now())

    room = relationship("Room")


class Member(Base):
    """밴드 멤버 명부. 소속은 member_teams 에 있다 (여러 팀 가능).
    team_id 는 그 중 대표 팀 — 카드 첫 줄과 정렬에만 쓴다."""
    __tablename__ = "members"

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id"), index=True)
    name = Column(String(50), nullable=False)
    phone = Column(String(30))
    parts = Column(String(200))  # comma-joined: "기타,보컬"
    gender = Column(String(10))  # 'male' | 'female'
    birth_year = Column(Integer)  # 몇 년생인지만 (생년월일 아님)
    # 도어즈 멤버십과 '어느 팀 소속이라 누가 회비를 내는가' 는 별개다.
    # 팀 이용료 팀으로 옮겨간 사람도 도어즈 멤버로는 계속 관리한다.
    is_doors = Column(Boolean, default=True, nullable=False)
    # 'member' 일반 | 'staff' 운영진 | 'leader' 모임장.
    # 운영진·모임장은 회비 기본값이 면제다 (그 달 기록을 남기면 그 값이 이긴다).
    role = Column(String(10), default='member', server_default='member', nullable=False)
    joined_on = Column(Date)
    is_active = Column(Boolean, default=True, nullable=False)
    # 연락이 안 되거나 최근 활동이 불확실한 멤버 표시. is_active 와 별개라
    # 확인 전까지는 정산 대상에 그대로 남는다.
    needs_check = Column(Boolean, default=False, nullable=False)
    dues_exempt = Column(Boolean, default=False, nullable=False)
    monthly_fee = Column(Integer)  # null = use app_settings.default_monthly_fee
    memo = Column(Text)
    created_at = Column(DateTime, server_default=func.now())

    dues = relationship("MemberDues", back_populates="member", cascade="all, delete-orphan")
    team = relationship("Team", back_populates="members")
    memberships = relationship(
        "MemberTeam", back_populates="member", cascade="all, delete-orphan",
    )


class MemberTeam(Base):
    """멤버 ↔ 팀 다대다. 한 사람이 밴드를 여러 개 할 수 있다.
    dues_exempt = 이 팀 몫 회비는 받지 않음 (members.dues_exempt 의 팀 단위 버전)."""
    __tablename__ = "member_teams"

    member_id = Column(Integer, ForeignKey("members.id", ondelete="CASCADE"), primary_key=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    dues_exempt = Column(Boolean, nullable=False, server_default='false')

    member = relationship("Member", back_populates="memberships")
    team = relationship("Team")


class MemberDues(Base):
    """(멤버, 팀, 달) 하나당 한 건. 두 밴드를 하면 그 달 회비도 두 건이다.
    team_id 가 NULL 이면 무소속일 때의 회비 — Postgres 15 의 NULLS NOT DISTINCT 로
    중복을 막는다 (마이그레이션에서 인덱스로 건다)."""
    __tablename__ = "member_dues"
    __table_args__ = (
        UniqueConstraint('member_id', 'team_id', 'year_month',
                         name='uq_member_dues_team_month',
                         postgresql_nulls_not_distinct=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    member_id = Column(Integer, ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    year_month = Column(String(7), nullable=False, index=True)  # 'YYYY-MM'
    status = Column(String(20), nullable=False, server_default='unpaid')  # paid|unpaid|exempt|pending
    amount = Column(Integer, nullable=False, server_default='0')
    paid_on = Column(Date)
    memo = Column(Text)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    member = relationship("Member", back_populates="dues")
    team = relationship("Team")


class TeamDues(Base):
    """월 이용료 팀의 달별 입금 기록. member_dues 와 같은 모양 — 내는 주체만 다르다."""
    __tablename__ = "team_dues"
    __table_args__ = (UniqueConstraint('team_id', 'year_month', name='uq_team_dues_month'),)

    id = Column(Integer, primary_key=True, index=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    year_month = Column(String(7), nullable=False, index=True)  # 'YYYY-MM'
    status = Column(String(20), nullable=False, server_default='unpaid')  # paid|unpaid|exempt|pending
    amount = Column(Integer, nullable=False, server_default='0')
    paid_on = Column(Date)
    memo = Column(Text)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    team = relationship("Team", back_populates="dues")


class Ticket(Base):
    __tablename__ = "tickets"

    id = Column(Integer, primary_key=True, index=True)
    slug = Column(String(16), unique=True, nullable=False, index=True)
    title = Column(String(200), nullable=False)
    bg_url = Column(String(300))
    map_url = Column(String(500))  # 길찾기 링크 (http/https 만 허용)
    aspect = Column(String(10), nullable=False, server_default='3:4')
    elements = Column(JSON, nullable=False, server_default='[]')
    is_published = Column(Boolean, default=False, nullable=False)
    # 열람·공유 집계. 원자적 UPDATE 로만 올린다 (updated_at 을 건드리지 않기 위해 raw SQL).
    view_count = Column(Integer, nullable=False, server_default='0')
    share_count = Column(Integer, nullable=False, server_default='0')
    copy_count = Column(Integer, nullable=False, server_default='0')
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AuditLog(Base):
    """관리자가 무엇을 바꿨는지 남긴다. 파일 로그와 달리 화면에서 조회된다.
    조회(GET)는 남기지 않는다 — 바뀐 것만 추적한다."""
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    at = Column(DateTime, server_default=func.now(), index=True)
    username = Column(String(50), index=True)
    action = Column(String(50), nullable=False, index=True)  # 'team.create' 같은 형태
    target = Column(String(200))    # 무엇을 대상으로 했는지 (이름 위주)
    detail = Column(Text)           # 사람이 읽는 한 줄 설명
    ip = Column(String(50))


class AppSetting(Base):
    __tablename__ = "app_settings"

    key = Column(String(50), primary_key=True)
    value = Column(Text)
