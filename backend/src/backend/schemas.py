"""Request/response schemas for the auth API.

Password hashes, session tokens, and other secrets never appear in a
response schema. Unknown request fields (e.g. client-supplied ``role``) are
ignored — they are never mapped onto model fields, which prevents privilege
escalation through registration payloads.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 200
NAME_MAX_LENGTH = 200
EMAIL_MAX_LENGTH = 320


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    full_name: str = Field(min_length=1, max_length=NAME_MAX_LENGTH)
    email: EmailStr = Field(max_length=EMAIL_MAX_LENGTH)
    password: str = Field(
        min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH
    )

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("full_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Full name must not be blank.")
        return stripped


class RegisterResponse(BaseModel):
    """201 response: the new (unverified) account plus honest delivery status
    for the verification email. The caller just created this account, so
    reporting delivery success/failure to them leaks nothing about other
    accounts."""

    id: UUID
    full_name: str
    email: EmailStr
    role: str
    is_active: bool
    is_email_verified: bool
    created_at: datetime
    updated_at: datetime
    verification_required: bool = True
    email_delivery: str = "accepted"  # "accepted" | "failed"


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    email: EmailStr
    password: str = Field(max_length=PASSWORD_MAX_LENGTH)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class UserPublic(BaseModel):
    """Safe user payload — the only user shape any endpoint may return."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    full_name: str
    email: EmailStr
    role: str
    is_active: bool
    is_email_verified: bool
    created_at: datetime
    updated_at: datetime


class VerifyEmailRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    token: str = Field(min_length=16, max_length=200)


class ResendVerificationRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    email: EmailStr = Field(max_length=EMAIL_MAX_LENGTH)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class VerifyEmailResponse(BaseModel):
    """Deliberately vague on account state: the same safe result shape for
    every outcome class callers can see."""

    message: str


class ResendVerificationResponse(BaseModel):
    """Always identical for any input that passes validation — verifying
    whether an email address has an account is not possible from this
    response."""

    message: str
