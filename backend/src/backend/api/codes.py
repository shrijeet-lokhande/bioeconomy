"""Shared auth response codes (kept dependency-free to avoid import cycles).

The structured code in 403 details lets the frontend distinguish "needs
email verification" from other rejections without parsing UI copy.
"""

VERIFICATION_REQUIRED_CODE = "email_verification_required"
VERIFICATION_REQUIRED_DETAIL = (
    "This account is not verified. Please confirm your email address first."
)

ADMIN_REQUIRED_CODE = "admin_required"
ADMIN_REQUIRED_MESSAGE = "Administrator access is required."

