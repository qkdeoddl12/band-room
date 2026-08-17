from sqlalchemy import (
    Column, Integer, String, Date, Time, Text, DateTime, ForeignKey, Boolean,
    JSON, UniqueConstraint,
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
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    members = relationship("Member", back_populates="team")

    @property
    def is_hourly(self) -> bool:
        return self.billing_type == 'hourly'


class Reservation(Base):
    __tablename__ = "reservations"

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"))
    date = Column(Date, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    duration = Column(Integer, nullable=False)
    team_name = Column(String(200))  # snapshot of team.name at booking time
    members = Column(Text)
    note = Column(Text)
    status = Column(String(20), nullable=False, server_default='pending')
    created_at = Column(DateTime, server_default=func.now())

    room = relationship("Room", back_populates="reservations")
    team = relationship("Team")


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
    """밴드 멤버 명부. team_id 로 소속 팀을 가리킨다 (NULL = 무소속)."""
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


class MemberDues(Base):
    __tablename__ = "member_dues"
    __table_args__ = (UniqueConstraint('member_id', 'year_month', name='uq_member_dues_month'),)

    id = Column(Integer, primary_key=True, index=True)
    member_id = Column(Integer, ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    year_month = Column(String(7), nullable=False, index=True)  # 'YYYY-MM'
    status = Column(String(20), nullable=False, server_default='unpaid')  # paid|unpaid|exempt|pending
    amount = Column(Integer, nullable=False, server_default='0')
    paid_on = Column(Date)
    memo = Column(Text)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    member = relationship("Member", back_populates="dues")


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


class AppSetting(Base):
    __tablename__ = "app_settings"

    key = Column(String(50), primary_key=True)
    value = Column(Text)
