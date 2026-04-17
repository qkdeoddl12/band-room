from pydantic import BaseModel, Field
from datetime import date, time, datetime
from typing import Optional


# ========== Room ==========
class RoomBase(BaseModel):
    name: str
    description: Optional[str] = None


class Room(RoomBase):
    id: int
    model_config = {"from_attributes": True}


# ========== Reservation ==========
class ReservationCreate(BaseModel):
    room_id: int
    date: date
    start_time: time
    duration: int
    team_name: Optional[str] = None
    members: Optional[str] = None
    note: Optional[str] = None


class ReservationResponse(BaseModel):
    id: int
    room_id: int
    date: date
    start_time: time
    end_time: time
    duration: int
    team_name: Optional[str] = None
    members: Optional[str] = None
    note: Optional[str] = None
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


# ========== Admin User ==========
class AdminUserResponse(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    created_at: datetime
    model_config = {"from_attributes": True}


class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=4)
    role: str = Field(..., pattern='^(system|reservation)$')


class UpdateUserRequest(BaseModel):
    password: Optional[str] = Field(None, min_length=4)
    role: Optional[str] = Field(None, pattern='^(system|reservation)$')
    is_active: Optional[bool] = None
