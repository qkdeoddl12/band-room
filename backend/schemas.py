from pydantic import BaseModel, Field
from datetime import date, time, datetime
import datetime as dt
from typing import Optional, List, Dict


# ========== Room ==========
class RoomBase(BaseModel):
    name: str
    description: Optional[str] = None


class Room(RoomBase):
    id: int
    hourly_price: int = 0
    booking_mode: str = 'team'
    model_config = {"from_attributes": True}


# ========== Reservation ==========
class ReservationCreate(BaseModel):
    room_id: int
    # 오픈 잼으로 잡는 예약. 주면 team_id 대신 이걸 본다.
    jam_id: Optional[int] = None
    # 방의 booking_mode 에 따라 무엇이 필요한지 갈린다 (서버에서 검증).
    #   team     → team_id 필수
    #   personal → booker_name 필수, 멤버가 아니면 booker_phone 도 필수
    team_id: Optional[int] = None
    booker_name: Optional[str] = Field(None, max_length=50)
    booker_phone: Optional[str] = Field(None, max_length=30)
    date: date
    start_time: time
    duration: int = Field(..., ge=1, le=24)   # 한 번에 최대 24시간 (자정을 넘기면 두 건으로 나뉜다)
    members: Optional[str] = None
    note: Optional[str] = None


# 관리자가 직접 만드는 예약 종류. 팀·개인은 이용자 쪽에서만 생긴다.
ADMIN_KIND_PATTERN = '^(rental|meetup)$'


class AdminReservationCreate(BaseModel):
    """장소 대관 · 도어즈 정모. 팀이 아니라 이름만 적는다."""
    kind: str = Field(..., pattern=ADMIN_KIND_PATTERN)
    room_id: int
    title: str = Field(..., min_length=1, max_length=200)
    date: dt.date
    start_time: dt.time
    duration: int = Field(..., ge=1, le=24)
    contact_phone: Optional[str] = Field(None, max_length=30)
    note: Optional[str] = None


class ReservationPublic(BaseModel):
    """로그인 없이 보는 타임라인용. **개인정보를 싣지 않는다** —
    이 엔드포인트는 인증이 없어서 주소만 알면 누구나 받아간다.
    연락처·메모·예약자 실명은 관리자용 응답에만 있다."""
    id: int
    room_id: int
    date: date
    start_time: time
    end_time: time
    duration: int
    team_name: Optional[str] = None   # 개인연습실·대관·정모는 예약 시점 이름 스냅샷
    members: Optional[str] = None     # 타임라인에 '누가 쓰는지' 로 이미 보여주던 값
    # 팀 합주와 대관·정모를 화면에서 갈라 보여주기 위해 종류는 공개한다 (개인정보 아님)
    kind: str = 'team'
    status: str = 'pending'
    group_key: Optional[str] = None   # 자정 넘김 예약을 한 건으로 묶어 보기 위해
    model_config = {"from_attributes": True}


class ReservationResponse(BaseModel):
    id: int
    room_id: int
    team_id: Optional[int] = None
    date: date
    start_time: time
    end_time: time
    duration: int
    team_name: Optional[str] = None
    member_id: Optional[int] = None
    booker_name: Optional[str] = None
    booker_phone: Optional[str] = None
    members: Optional[str] = None
    note: Optional[str] = None
    kind: str = 'team'
    status: str = 'pending'
    is_free: bool = False
    group_key: Optional[str] = None
    created_at: datetime
    room: Room
    model_config = {"from_attributes": True}


class ReservationCreated(ReservationResponse):
    """예약을 만든 본인에게만 돌려주는 응답. 취소 토큰이 여기에만 실린다."""
    cancel_token: Optional[str] = None


class ReservationAdminUpdate(BaseModel):
    """관리자가 예약을 고칠 때. 보낸 항목만 바뀐다.
    시간·날짜·공간을 건드리면 서버가 슬롯을 다시 검사하고, 자정을 넘기면 다시 쪼갠다."""
    room_id: Optional[int] = None
    # dt.date 로 쓴다 — 필드 이름이 date 라 `= None` 을 붙이는 순간 클래스 안에서
    # date 라는 이름이 None 으로 덮여 타입이 None 이 돼버린다 (실제로 422 가 났었다).
    date: Optional[dt.date] = None
    start_time: Optional[dt.time] = None
    duration: Optional[int] = Field(None, ge=1, le=24)
    team_id: Optional[int] = None
    booker_name: Optional[str] = Field(None, max_length=50)
    booker_phone: Optional[str] = Field(None, max_length=30)
    # 대관·정모의 표시 이름 (팀 예약에는 쓰지 않는다)
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    members: Optional[str] = None
    note: Optional[str] = None


class ReservationCancel(BaseModel):
    token: str = Field(..., min_length=8, max_length=64)


# ========== Auth ==========
class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str
    must_change_password: bool = False


class ChangePasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=4)


# ========== Admin User ==========
class AdminUserResponse(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    must_change_password: bool = False
    created_at: datetime
    model_config = {"from_attributes": True}


class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    role: str = Field(..., pattern='^(system|reservation)$')


class CreateUserResponse(BaseModel):
    user: AdminUserResponse
    temp_password: str


class UpdateUserRequest(BaseModel):
    password: Optional[str] = Field(None, min_length=4)
    role: Optional[str] = Field(None, pattern='^(system|reservation)$')
    is_active: Optional[bool] = None


# ========== Blocked Period ==========
class BlockedPeriodCreate(BaseModel):
    date: date
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    room_id: Optional[int] = None
    reason: Optional[str] = Field(None, max_length=200)


# ========== Inquiry ==========
class InquiryCreate(BaseModel):
    category: str = Field(..., pattern='^(question|complaint|incident)$')
    content: str = Field(..., min_length=1, max_length=2000)
    contact_name: Optional[str] = Field(None, max_length=100)
    contact_phone: Optional[str] = Field(None, max_length=30)


class InquiryResponse(BaseModel):
    id: int
    category: str
    content: str
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    status: str
    resolved_by: Optional[str] = None
    resolved_at: Optional[datetime] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class BlockedPeriodResponse(BaseModel):
    id: int
    date: date
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    room_id: Optional[int] = None
    reason: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    model_config = {"from_attributes": True}


# ========== Team ==========
BILLING_PATTERN = '^(hourly|monthly|dues)$'


class TeamCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    leader_name: Optional[str] = Field(None, max_length=50)
    phone: Optional[str] = Field(None, max_length=30)
    parts: Optional[str] = Field(None, max_length=200)
    memo: Optional[str] = None
    # hourly = 시간당 / monthly = 팀 월 이용료 / dues = 멤버별 월회비
    billing_type: str = Field('hourly', pattern=BILLING_PATTERN)
    monthly_fee: Optional[int] = Field(None, ge=0)
    dues_fee: Optional[int] = Field(None, ge=0)
    is_doors: bool = True
    is_active: bool = True


class TeamUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    leader_name: Optional[str] = Field(None, max_length=50)
    phone: Optional[str] = Field(None, max_length=30)
    parts: Optional[str] = Field(None, max_length=200)
    memo: Optional[str] = None
    billing_type: Optional[str] = Field(None, pattern=BILLING_PATTERN)
    monthly_fee: Optional[int] = Field(None, ge=0)
    dues_fee: Optional[int] = Field(None, ge=0)
    is_doors: Optional[bool] = None
    is_active: Optional[bool] = None


class TeamPublic(BaseModel):
    id: int
    name: str
    billing_type: str = 'hourly'
    model_config = {"from_attributes": True}


class TeamResponse(BaseModel):
    id: int
    name: str
    leader_name: Optional[str] = None
    phone: Optional[str] = None
    parts: Optional[str] = None
    memo: Optional[str] = None
    billing_type: str = 'hourly'
    monthly_fee: Optional[int] = None
    dues_fee: Optional[int] = None
    is_doors: bool = True
    is_active: bool
    created_at: datetime
    reservation_count: int = 0
    member_count: int = 0
    # 출생년도를 아는 멤버만 센다. 아무도 없으면 None / 빈 dict.
    age_avg: Optional[float] = None
    age_buckets: Dict[str, int] = {}
    # 레퍼토리 중 완곡 수. "이 팀이 무대에 올릴 수 있는 곡이 몇 개인가"
    done_song_count: int = 0
    model_config = {"from_attributes": True}


# ========== Meetup record (정모 기록) ==========
# 'dues' 월회비로 참석 | 'walk_in' 당일 참가비 | 'free' 무료 참관
PAY_TYPE_PATTERN = '^(dues|walk_in|free)$'


class MeetupAttendeeIn(BaseModel):
    member_id: Optional[int] = None            # 도어즈 멤버면 지정, 외부 게스트면 없음
    name: str = Field(..., min_length=1, max_length=50)
    pay_type: str = Field('dues', pattern=PAY_TYPE_PATTERN)
    fee: int = Field(0, ge=0)                  # walk_in 일 때만 의미가 있다
    memo: Optional[str] = Field(None, max_length=200)


class MeetupSongIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    lineup: Optional[str] = Field(None, max_length=500)


class MeetupRecordUpsert(BaseModel):
    """기록 전체를 통째로 저장한다. 참석자·곡은 한 화면에서 함께 고치므로
    항목별 API 를 두는 것보다 한 번에 갈아끼우는 편이 단순하다."""
    memo: Optional[str] = None
    photos: List[str] = Field(default_factory=list, max_length=30)
    attendees: List[MeetupAttendeeIn] = Field(default_factory=list, max_length=100)
    songs: List[MeetupSongIn] = Field(default_factory=list, max_length=40)


class MeetupAttendeeOut(BaseModel):
    id: int
    member_id: Optional[int] = None
    name: str
    pay_type: str
    fee: int
    memo: Optional[str] = None
    model_config = {"from_attributes": True}


class MeetupSongOut(BaseModel):
    id: int
    title: str
    lineup: Optional[str] = None
    sort_order: int = 0
    model_config = {"from_attributes": True}


class MeetupRecordOut(BaseModel):
    id: int
    reservation_id: int
    # 예약이 갖고 있는 값 — 기록에 다시 적지 않고 끌어온다
    title: Optional[str] = None
    date: Optional[dt.date] = None
    start_time: Optional[dt.time] = None
    end_time: Optional[dt.time] = None
    room_name: Optional[str] = None
    memo: Optional[str] = None
    photos: List[str] = []
    attendees: List[MeetupAttendeeOut] = []
    songs: List[MeetupSongOut] = []
    # 화면에서 매번 세지 않도록 서버가 미리 센다
    attend_count: int = 0
    walk_in_count: int = 0
    free_count: int = 0
    walk_in_total: int = 0
    updated_at: Optional[datetime] = None


class MeetupSlot(BaseModel):
    """아직 기록이 없는 정모 예약. '기록 만들기' 목록에 쓴다."""
    reservation_id: int
    title: Optional[str] = None
    date: dt.date
    start_time: dt.time
    end_time: dt.time
    room_name: Optional[str] = None


# ========== Open Jam (오픈 잼) ==========
JAM_STATUS_PATTERN = '^(recruiting|closed|done)$'


class OpenJamSlotCreate(BaseModel):
    part: str = Field(..., min_length=1, max_length=50)
    count: int = Field(1, ge=1, le=10)   # "기타 2" 를 슬롯 2개로 펼친다


class OpenJamCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    leader_name: str = Field(..., min_length=1, max_length=50)   # 이름으로 멤버를 찾는다
    target_period: Optional[str] = Field(None, max_length=100)
    memo: Optional[str] = None
    slots: List[OpenJamSlotCreate] = Field(..., min_length=1, max_length=12)


class OpenJamClaim(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)


class OpenJamToken(BaseModel):
    token: str = Field(..., min_length=8, max_length=64)


class OpenJamStatusChange(BaseModel):
    token: str = Field(..., min_length=8, max_length=64)
    status: str = Field(..., pattern=JAM_STATUS_PATTERN)


class OpenJamSlotPublic(BaseModel):
    """공개 목록용. 연락처는 싣지 않는다 — 이름과 포지션만."""
    id: int
    part: str
    sort_order: int = 0
    member_name: Optional[str] = None     # 비어 있으면 아직 빈 자리
    model_config = {"from_attributes": True}


class OpenJamPublic(BaseModel):
    """공개 목록용. **manage_token / claim_token 을 절대 싣지 않는다** —
    실으면 남의 잼을 마감·삭제하거나 남의 자리를 뺄 수 있다."""
    id: int
    title: str
    leader_name: Optional[str] = None
    target_period: Optional[str] = None
    memo: Optional[str] = None
    status: str
    slots: List[OpenJamSlotPublic] = []
    created_at: datetime
    # 모집 마감 후 며칠 지났나. 아무도 종료를 안 누르면 목록에 계속 남으므로
    # "오래됐다"를 화면에 보여준다 (자동으로 종료시키지는 않는다).
    closed_days: Optional[int] = None
    is_stale: bool = False
    model_config = {"from_attributes": True}


class OpenJamCreated(OpenJamPublic):
    """발제한 본인에게만 돌려주는 응답. 관리 열쇠가 여기에만 실린다."""
    manage_token: Optional[str] = None


class OpenJamClaimed(BaseModel):
    """자리를 잡은 본인에게만. 취소 열쇠가 여기에만 실린다."""
    slot_id: int
    jam_id: int
    part: str
    member_name: str
    claim_token: str


class OpenJamAdminSlot(OpenJamSlotPublic):
    member_id: Optional[int] = None
    member_phone: Optional[str] = None
    claimed_at: Optional[datetime] = None


class OpenJamAdmin(BaseModel):
    """관리자 화면. 연락처까지 본다."""
    id: int
    title: str
    leader_name: Optional[str] = None
    leader_phone: Optional[str] = None
    target_period: Optional[str] = None
    memo: Optional[str] = None
    status: str
    slots: List[OpenJamAdminSlot] = []
    created_at: datetime
    closed_days: Optional[int] = None
    is_stale: bool = False


class OpenJamAdminUpdate(BaseModel):
    status: Optional[str] = Field(None, pattern=JAM_STATUS_PATTERN)


# ========== Team songs (레퍼토리) ==========
SONG_STATUS_PATTERN = '^(candidate|practicing|done)$'


class SongCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    artist: Optional[str] = Field(None, max_length=100)
    link: Optional[str] = Field(None, max_length=500)
    memo: Optional[str] = None
    status: str = Field('candidate', pattern=SONG_STATUS_PATTERN)


class SongUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    artist: Optional[str] = Field(None, max_length=100)
    link: Optional[str] = Field(None, max_length=500)
    memo: Optional[str] = None
    status: Optional[str] = Field(None, pattern=SONG_STATUS_PATTERN)


class SongResponse(BaseModel):
    id: int
    team_id: int
    title: str
    artist: Optional[str] = None
    link: Optional[str] = None
    memo: Optional[str] = None
    status: str
    created_at: datetime
    model_config = {"from_attributes": True}


# ========== Member (도어즈) ==========
GENDER_PATTERN = '^(male|female)$'


class MemberTeamRef(BaseModel):
    """멤버가 속한 팀 하나. dues_exempt = 이 팀 몫 회비는 안 받음."""
    id: int
    name: str
    billing_type: str = 'hourly'
    dues_exempt: bool = False


class MemberCreate(BaseModel):
    # team_ids 가 소속의 정본. team_id 는 옛 단일 소속 호출을 위해 남겨둔 입력이고,
    # 응답에서는 '대표 팀'(team_ids 의 첫 팀) 을 뜻한다.
    team_ids: Optional[List[int]] = None
    team_exempt_ids: Optional[List[int]] = None
    team_id: Optional[int] = None
    is_doors: bool = True
    name: str = Field(..., min_length=1, max_length=50)
    phone: Optional[str] = Field(None, max_length=30)
    parts: Optional[str] = Field(None, max_length=200)
    gender: Optional[str] = Field(None, pattern=GENDER_PATTERN)
    birth_year: Optional[int] = Field(None, ge=1900, le=2100)
    joined_on: Optional[date] = None
    is_active: bool = True
    needs_check: bool = False
    dues_exempt: bool = False
    monthly_fee: Optional[int] = Field(None, ge=0)
    memo: Optional[str] = None


class MemberUpdate(BaseModel):
    team_ids: Optional[List[int]] = None
    team_exempt_ids: Optional[List[int]] = None
    team_id: Optional[int] = None
    is_doors: Optional[bool] = None
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    phone: Optional[str] = Field(None, max_length=30)
    parts: Optional[str] = Field(None, max_length=200)
    gender: Optional[str] = Field(None, pattern=GENDER_PATTERN)
    birth_year: Optional[int] = Field(None, ge=1900, le=2100)
    joined_on: Optional[date] = None
    is_active: Optional[bool] = None
    needs_check: Optional[bool] = None
    dues_exempt: Optional[bool] = None
    monthly_fee: Optional[int] = Field(None, ge=0)
    memo: Optional[str] = None


class MemberResponse(BaseModel):
    id: int
    # 대표 팀 (소속 목록의 첫 팀). 전체 소속은 teams 를 본다.
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    teams: List[MemberTeamRef] = []
    is_doors: bool = True
    name: str
    phone: Optional[str] = None
    parts: Optional[str] = None
    gender: Optional[str] = None
    birth_year: Optional[int] = None
    joined_on: Optional[date] = None
    is_active: bool
    needs_check: bool = False
    dues_exempt: bool
    monthly_fee: Optional[int] = None
    memo: Optional[str] = None
    created_at: datetime
    model_config = {"from_attributes": True}


# ========== Dues (월회비) ==========
class DuesUpsert(BaseModel):
    status: str = Field(..., pattern='^(paid|unpaid|exempt|pending)$')
    amount: Optional[int] = Field(None, ge=0)
    paid_on: Optional[date] = None
    memo: Optional[str] = None


class DuesRow(BaseModel):
    """(멤버, 팀, 달) 한 건. 두 밴드를 하면 같은 사람의 행이 두 개 나온다 —
    프론트에서 행을 찾을 때 member_id 만으로는 부족하고 team_id 까지 봐야 한다."""
    member_id: int
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    # 소속 팀이 월 이용료를 내는 경우 — 개인 회비 대상이 아니다.
    covered_by_team: bool = False
    name: str
    parts: Optional[str] = None
    dues_exempt: bool
    fee: int
    status: str
    amount: int
    paid_on: Optional[date] = None
    memo: Optional[str] = None


class TeamDuesRow(BaseModel):
    """월 이용료를 팀이 통째로 내는 경우의 한 달치."""
    team_id: int
    name: str
    member_count: int = 0
    fee: int
    status: str
    amount: int
    paid_on: Optional[date] = None
    memo: Optional[str] = None


class DuesMonthResponse(BaseModel):
    year_month: str
    rows: List[DuesRow]
    total_expected: int
    total_paid: int
    unpaid_count: int
    pending_count: int
    exempt_count: int
    covered_count: int = 0
    # 월 이용료 팀은 사람 단위가 아니라 팀 단위로 낸다 — 합계도 따로 센다.
    team_rows: List[TeamDuesRow] = []
    team_total_expected: int = 0
    team_total_paid: int = 0
    # 정모 당일 참가비 — 세 번째 수입. 회비·이용료와 절대 합치지 않는다.
    walk_in_total: int = 0
    walk_in_count: int = 0
    walk_in_meetups: int = 0


class DuesHistoryRow(BaseModel):
    """멤버·팀 상세에서 보는 달별 입금 이력 한 줄.
    멤버 이력에는 소속 팀이 여럿 섞여 나오므로 어느 팀 몫인지 함께 보낸다."""
    year_month: str
    team_name: Optional[str] = None
    status: str
    amount: int
    paid_on: Optional[date] = None
    memo: Optional[str] = None


class DuesSummaryRow(BaseModel):
    year_month: str
    paid: int            # 멤버 월회비
    team_paid: int = 0   # 팀 월 이용료 — 성격이 달라 합치지 않는다
    walk_in_paid: int = 0  # 정모 당일 참가비 — 세 번째 계열
    unpaid_count: int


# ========== Ticket ==========
# 자동 생성 slug 는 secrets.token_urlsafe 라 대문자·밑줄이 섞인다.
# 수정 저장 때 쓰는 검사도 그걸 받아줘야 한다 — 안 그러면 자동 생성된 티켓은
# 슬러그를 손으로 고치기 전엔 저장 자체가 안 된다 (422). 실제로 겪음.
SLUG_PATTERN = r'^[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]$'


class TicketElement(BaseModel):
    id: str = Field(..., max_length=20)
    text: str = Field('', max_length=300)
    x: float = Field(50, ge=0, le=100)
    y: float = Field(50, ge=0, le=100)
    size: float = Field(6, ge=0.5, le=40)
    color: str = Field('#FFFFFF', pattern='^#[0-9a-fA-F]{6}$')
    weight: int = Field(700, ge=100, le=900)
    align: str = Field('center', pattern='^(left|center|right)$')
    shadow: bool = True


class TicketCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


class TicketUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    # 공유 주소 뒷부분(/t/여기). 영소문자·숫자·하이픈만.
    slug: Optional[str] = Field(None, min_length=3, max_length=32,
                                pattern=SLUG_PATTERN)
    bg_url: Optional[str] = Field(None, max_length=300)
    map_url: Optional[str] = Field(None, max_length=500)
    aspect: Optional[str] = Field(None, pattern=r'^\d{1,2}:\d{1,2}$')
    elements: Optional[List[TicketElement]] = Field(None, max_length=40)
    is_published: Optional[bool] = None


class TicketResponse(BaseModel):
    id: int
    slug: str
    title: str
    bg_url: Optional[str] = None
    map_url: Optional[str] = None
    aspect: str
    elements: List[TicketElement] = []
    is_published: bool
    view_count: int = 0
    share_count: int = 0
    copy_count: int = 0
    created_at: datetime
    updated_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class TicketPublic(BaseModel):
    slug: str
    title: str
    bg_url: Optional[str] = None
    map_url: Optional[str] = None
    aspect: str
    elements: List[TicketElement] = []
    model_config = {"from_attributes": True}


class MemberCheckRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    # 어느 달 회비를 볼지. 예약하려는 날짜를 넘긴다 (없으면 오늘).
    # 주의: 기본값이 있는 필드는 클래스 속성을 만들어 같은 이름의 타입을 가린다.
    # `date: Optional[date] = None` 로 쓰면 타입이 NoneType 이 되어 422 가 난다.
    date: Optional[dt.date] = None


class MemberCheckResponse(BaseModel):
    """예약 페이지에서 이름만 확인한다. 명단이 새 나가지 않도록
    이름 존재 여부와 회비 상태 외에는 아무것도 돌려주지 않는다."""
    is_member: bool = False
    dues_ok: bool = False
    ambiguous: bool = False
    message: str = ''


# ========== Audit log ==========
class AuditLogResponse(BaseModel):
    id: int
    at: datetime
    username: Optional[str] = None
    action: str
    target: Optional[str] = None
    detail: Optional[str] = None
    ip: Optional[str] = None
    model_config = {"from_attributes": True}


# ========== Settings ==========
class PublicSettings(BaseModel):
    deposit_bank: str = ''
    deposit_account: str = ''
    deposit_holder: str = ''


BOOKING_MODE_PATTERN = '^(team|personal)$'


class RoomUpdate(BaseModel):
    hourly_price: int = Field(..., ge=0)
    booking_mode: Optional[str] = Field(None, pattern=BOOKING_MODE_PATTERN)


class SettingsUpdate(BaseModel):
    values: Dict[str, str]
