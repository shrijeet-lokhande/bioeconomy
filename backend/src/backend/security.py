"""Password hashing with Argon2id (argon2-cffi).

Hash format is the standard PHC string starting with ``$argon2id$``. No
plaintext or reversible encoding of passwords exists anywhere in this code
or in logged/output data.
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# OWASP-recommended parameters are the library defaults:
# argon2id, t=3, m=64 MiB, p=4, 16-byte salt.
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bool(_hasher.verify(password_hash, password))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
