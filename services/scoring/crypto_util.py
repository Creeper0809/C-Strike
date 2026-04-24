"""SSH 비밀번호 Fernet 복호화 유틸 (scoring-engine용)."""

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def decrypt_password(ciphertext: str) -> str:
    """암호화된 SSH 비밀번호를 복호화한다."""
    raw = settings.SSH_ENCRYPTION_KEY
    if not raw:
        raise RuntimeError("SCORING_SSH_ENCRYPTION_KEY 환경변수가 설정되지 않았습니다")
    key = raw.encode() if isinstance(raw, str) else raw
    f = Fernet(key)
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        raise ValueError("SSH 비밀번호 복호화 실패")
