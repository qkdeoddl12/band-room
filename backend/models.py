from sqlalchemy import Column, Integer, String, Date, Time, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Room(Base):
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    reservations = relationship("Reservation", back_populates="room")


class Reservation(Base):
    __tablename__ = "reservations"

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    date = Column(Date, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    duration = Column(Integer, nullable=False)
    team_name = Column(String(200))
    members = Column(Text)
    note = Column(Text)
    status = Column(String(20), nullable=False, server_default='pending')
    created_at = Column(DateTime, server_default=func.now())

    room = relationship("Room", back_populates="reservations")


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
