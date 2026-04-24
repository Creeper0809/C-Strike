"""팀 네트워크 격리 상태 관리 — Redis 기반.

운영자가 격리/복구 버튼을 눌렀을 때 격리 상태를 Redis에 명시적으로 기록한다.
실제 iptables 차단은 인프라 담당자(라우터/방화벽) 영역이며, 본 모듈은
격리 상태 추적과 운영 포털 화면 반영만 책임진다.

Redis 키 구조:
  network:isolation:team:{team_id}                Hash {reason, isolated_at, operator_id, competition_id}
  network:isolation:competition:{competition_id}  Set of team_id (대회별 인덱스)

Redis 미연결 시 모든 조회 함수는 안전한 기본값(False/None/빈 set)을 반환한다.
"""

from datetime import datetime, timezone
from uuid import UUID

from app.redis_client import get_redis


_TEAM_KEY_PREFIX = "network:isolation:team:"
_COMPETITION_KEY_PREFIX = "network:isolation:competition:"


def _team_key(team_id: UUID) -> str:
    return f"{_TEAM_KEY_PREFIX}{team_id}"


def _competition_key(competition_id: UUID) -> str:
    return f"{_COMPETITION_KEY_PREFIX}{competition_id}"


async def set_team_isolated(
    team_id: UUID,
    competition_id: UUID,
    reason: str,
    operator_id: UUID,
) -> datetime:
    """팀을 격리 상태로 설정한다."""
    isolated_at = datetime.now(timezone.utc)
    try:
        redis = await get_redis()
        await redis.hset(
            _team_key(team_id),
            mapping={
                "reason": reason,
                "isolated_at": isolated_at.isoformat(),
                "operator_id": str(operator_id),
                "competition_id": str(competition_id),
            },
        )
        await redis.sadd(_competition_key(competition_id), str(team_id))
    except Exception:
        pass
    return isolated_at


async def clear_team_isolated(team_id: UUID, competition_id: UUID) -> None:
    """팀의 격리 상태를 해제한다."""
    try:
        redis = await get_redis()
        await redis.delete(_team_key(team_id))
        await redis.srem(_competition_key(competition_id), str(team_id))
    except Exception:
        pass


async def is_team_isolated(team_id: UUID) -> bool:
    """팀이 격리 상태인지 확인한다."""
    try:
        redis = await get_redis()
        return bool(await redis.exists(_team_key(team_id)))
    except Exception:
        return False


async def get_isolation_info(team_id: UUID) -> dict | None:
    """격리 정보(이유, 시간, 운영자)를 조회한다."""
    try:
        redis = await get_redis()
        data = await redis.hgetall(_team_key(team_id))
        return data if data else None
    except Exception:
        return None


async def get_isolated_team_ids(competition_id: UUID) -> set[str]:
    """대회에서 격리된 팀 ID 문자열 집합을 조회한다."""
    try:
        redis = await get_redis()
        members = await redis.smembers(_competition_key(competition_id))
        return set(members) if members else set()
    except Exception:
        return set()


async def isolate_all_teams(
    competition_id: UUID,
    team_ids: list[UUID],
    reason: str,
    operator_id: UUID,
) -> datetime:
    """대회의 모든 팀을 일괄 격리한다."""
    isolated_at = datetime.now(timezone.utc)
    try:
        redis = await get_redis()
        comp_key = _competition_key(competition_id)
        async with redis.pipeline(transaction=False) as pipe:
            for team_id in team_ids:
                pipe.hset(
                    _team_key(team_id),
                    mapping={
                        "reason": reason,
                        "isolated_at": isolated_at.isoformat(),
                        "operator_id": str(operator_id),
                        "competition_id": str(competition_id),
                    },
                )
                pipe.sadd(comp_key, str(team_id))
            await pipe.execute()
    except Exception:
        pass
    return isolated_at


async def restore_all_teams(competition_id: UUID, team_ids: list[UUID]) -> None:
    """대회의 모든 팀의 격리 상태를 일괄 해제한다."""
    try:
        redis = await get_redis()
        comp_key = _competition_key(competition_id)
        async with redis.pipeline(transaction=False) as pipe:
            for team_id in team_ids:
                pipe.delete(_team_key(team_id))
            pipe.delete(comp_key)
            await pipe.execute()
    except Exception:
        pass
