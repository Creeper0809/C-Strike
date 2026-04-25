"""운영자(Operator) 관리 API 요청/응답 Pydantic 스키마."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


# Discord snowflake ID 검증: 18~20자리 순수 숫자 문자열
_DISCORD_ID_REGEX = r"^\d{18,20}$"


class OperatorCreateRequest(BaseModel):
    """POST /api/operators — 운영자 신규 생성.

    UX 단순화: 필수 입력은 discord_user_id와 display_name 두 가지뿐.
    username/password 미제공 시 백엔드가 자동 생성한다.
    """

    discord_user_id: str = Field(
        ...,
        max_length=32,
        pattern=_DISCORD_ID_REGEX,
        description="Discord 사용자 ID (18~20자리 숫자 문자열). 운영진 역할 자동 부여 대상.",
    )
    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    role: Literal["admin", "operator"] = "operator"
    username: str | None = Field(
        default=None,
        min_length=1,
        max_length=50,
        description="로그인 ID. 미제공 시 백엔드가 'op_{discord_user_id}' 패턴으로 자동 생성.",
    )
    password: str | None = Field(
        default=None,
        min_length=8,
        max_length=255,
        description="비밀번호. 미제공 시 백엔드가 랜덤 생성하여 응답 1회만 반환.",
    )


class OperatorUpdateRequest(BaseModel):
    """PATCH /api/operators/{operator_id} — 부분 수정, 변경할 필드만 전송."""

    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    role: Literal["admin", "operator"] | None = None
    is_active: bool | None = None
    discord_user_id: str | None = Field(
        default=None,
        max_length=32,
        pattern=_DISCORD_ID_REGEX,
        description="빈 문자열 '' 또는 null로 보내면 연동 해제 + Discord 역할 revoke.",
    )
    password: str | None = Field(default=None, min_length=8, max_length=255)


class OperatorResponse(BaseModel):
    """운영자 단건 응답. 비밀번호 해시는 노출하지 않는다."""

    id: UUID
    username: str
    display_name: str
    role: str
    is_active: bool
    discord_user_id: str | None = None
    last_login_at: datetime | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class OperatorListResponse(BaseModel):
    """GET /api/operators — 전체 목록 응답."""

    items: list[OperatorResponse]
    total: int


class OperatorCreateResponse(OperatorResponse):
    """POST /api/operators 응답. 자동 생성된 비밀번호를 1회만 포함.

    백엔드가 password를 랜덤 생성한 경우 generated_password 필드로 평문을 돌려준다.
    관리자는 이 값을 즉시 복사해 대상자에게 전달해야 하며, 이후 재조회는 불가.
    사용자가 직접 password를 입력한 경우 generated_password는 None.
    """

    generated_password: str | None = None
