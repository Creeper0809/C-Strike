"""SSH 비밀번호 Fernet 암/복호화 유틸."""

import logging

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

logger = logging.getLogger(__name__)

_KEY_CACHE: bytes | None = None


def _get_key() -> bytes:
    """설정에서 Fernet 키를 읽어온다. 기본값이면 자동 생성 후 경고."""
    global _KEY_CACHE
    if _KEY_CACHE is not None:
        return _KEY_CACHE

    raw = settings.SSH_ENCRYPTION_KEY
    if raw == "your-fernet-key-change-in-production":
        logger.warning(
            "SSH_ENCRYPTION_KEY가 기본값입니다. 운영 환경에서는 반드시 변경하세요. "
            "생성 명령: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"",
        )
        _KEY_CACHE = Fernet.generate_key()
    else:
        _KEY_CACHE = raw.encode() if isinstance(raw, str) else raw
    return _KEY_CACHE


def encrypt_password(plaintext: str) -> str:
    """평문 비밀번호를 Fernet으로 암호화한다."""
    f = Fernet(_get_key())
    return f.encrypt(plaintext.encode()).decode()


def decrypt_password(ciphertext: str) -> str:
    """암호화된 비밀번호를 복호화한다."""
    f = Fernet(_get_key())
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        raise ValueError("SSH 비밀번호 복호화 실패: 암호화 키가 변경되었거나 데이터가 손상되었습니다.")
