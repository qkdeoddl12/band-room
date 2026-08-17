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
    # 방의 booking_mode 에 따라 무엇이 필요한지 갈린다 (서버에서 검증).
    #   team     → team_id 필수
    #   personal → booker_name 필수, 멤버가 아니면 booker_phone 도 필수
    team_id: Optional[int] = None
    booker_name: Optional[str] = Field(None, max_length=50)
    booker_phone: Optional[str] = Field(None, max_length=30)
    date: date
    start_time: time
    duration: int = Field(..., ge=1, le=14)
    members: Optional[str] = None
    note: Optional[str] = None


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
    status: str = 'pending'
    is_free: bool = False
    created_at: datetime
    room: Room
    model_config = {"from_attributes": True}


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
    is_active: bool
    created_at: datetime
    reservation_count: int = 0
    member_count: int = 0
    model_config = {"from_attributes": True}


# ========== Member (도어즈) ==========
GENDER_PATTERN = '^(male|female)$'


class MemberCreate(BaseModel):
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
    team_id: Optional[int] = None
    team_name: Optional[str] = None
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


class DuesMonthResponse(BaseModel):
    year_month: str
    rows: List[DuesRow]
    total_expected: int
    total_paid: int
    unpaid_count: int
    pending_count: int
    exempt_count: int
    covered_count: int = 0


class DuesSummaryRow(BaseModel):
    year_month: str
    paid: int
    unpaid_count: int


# ========== Ticket ==========
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
                                pattern=r'^[a-z0-9][a-z0-9-]*[a-z0-9]$')
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
