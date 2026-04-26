"""운영 포털 공개 API 응답 → 스코어보드 v2 프론트 기대 스키마 변환.

매핑 (운영 포털 실제 스키마 → v2 프론트 상태 트리):
    info.current_round            → state.round
    info.is_frozen                → state.is_frozen
    info.teams                    → state.teams
    info.services                 → state.services (released 팩 서비스만)
    info.all_services             → state.all_services
    info.vulnpacks                → state.vulnpack_schedule
    rankings.rankings             → state.rankings (team_name → id 매핑)
    chart.scores (team_name→list) → state.score_history (team_id → list)
    events.events[flag_captured]  → state.attack_matrix (이름 → id 역매핑)
    (운영 포털 미제공)             → state.defense_record (빈 객체)
    (운영 포털 미제공)             → state.bonus.problems (빈 배열)

운영 포털 ``RankingEntry``에는 ``team_id``가 없고, ``EventEntry.details``는
공격자/피해자/서비스를 **이름 문자열**로만 담는다. 따라서 어댑터는
``info.teams`` / ``info.all_services``의 이름 → id 역매핑을 먼저 구성한 뒤
rankings와 events를 변환한다.
"""

from __future__ import annotations

from typing import Any


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def build_state(bundled: dict[str, Any]) -> dict[str, Any]:
    """API 응답 묶음을 v2 프론트 기대 스키마로 변환한다.

    어떤 필드가 빠져있거나 타입이 달라도 안전한 기본값으로 대체되며 예외를
    던지지 않는다. v2 프론트(``scoreboard.js``)의 가드가 빈 구조를 허용한다.
    """
    info = _safe_dict(bundled.get("info"))
    rankings_body = _safe_dict(bundled.get("rankings"))
    chart = _safe_dict(bundled.get("chart"))
    events_body = _safe_dict(bundled.get("events"))

    teams = _safe_list(info.get("teams"))
    services = _safe_list(info.get("services"))
    all_services = _safe_list(info.get("all_services"))
    vulnpacks = _safe_list(info.get("vulnpacks"))

    team_by_name: dict[str, dict[str, Any]] = {
        t["name"]: t for t in teams if isinstance(t, dict) and "name" in t
    }
    service_by_name: dict[str, dict[str, Any]] = {
        s["name"]: s for s in all_services if isinstance(s, dict) and "name" in s
    }

    score_history = _build_score_history(teams, chart, team_by_name)
    attack_matrix = _build_attack_matrix(
        teams, all_services, events_body, team_by_name, service_by_name
    )
    v2_rankings = _build_rankings(rankings_body, team_by_name)

    return {
        "competition_name": info.get("name") or "C-STRIKE",
        "round": int(info.get("current_round", 0) or 0),
        "is_frozen": bool(info.get("is_frozen", False)),
        "rankings": v2_rankings,
        "teams": teams,
        "score_history": score_history,
        "vulnpack_schedule": vulnpacks,
        "services": services or all_services,
        "all_services": all_services,
        "attack_matrix": attack_matrix,
        "defense_record": {},           # 운영 포털 미제공 — UI 가드 보호용
        "bonus": {"problems": []},      # 운영 포털 미제공
    }


def _build_score_history(
    teams: list[Any],
    chart: dict[str, Any],
    team_by_name: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """``chart.scores`` (team_name → [scores])를 team_id 기준 포인트 리스트로 변환."""
    history: dict[str, list[dict[str, Any]]] = {
        t["id"]: [] for t in teams if isinstance(t, dict) and "id" in t
    }

    chart_rounds = _safe_list(chart.get("rounds"))
    scores_map = _safe_dict(chart.get("scores"))

    for team_name, score_list in scores_map.items():
        team = team_by_name.get(team_name)
        if not team or "id" not in team:
            continue
        points: list[dict[str, Any]] = []
        for idx, total in enumerate(_safe_list(score_list)):
            round_no = chart_rounds[idx] if idx < len(chart_rounds) else idx + 1
            points.append({"round": round_no, "total": total})
        history[team["id"]] = points

    return history


def _build_attack_matrix(
    teams: list[Any],
    all_services: list[Any],
    events_body: dict[str, Any],
    team_by_name: dict[str, dict[str, Any]],
    service_by_name: dict[str, dict[str, Any]],
) -> dict[str, dict[str, dict[str, int]]]:
    """flag_captured 이벤트를 집계하여 {svc_id: {atk_id: {vic_id: count}}} 생성.

    운영 포털 이벤트의 ``details``는 이름만 담으므로 팀/서비스 이름을 먼저
    id로 역매핑한다.
    """
    matrix: dict[str, dict[str, dict[str, int]]] = {}
    valid_team_ids = [t["id"] for t in teams if isinstance(t, dict) and "id" in t]

    for svc in all_services:
        if not isinstance(svc, dict) or "id" not in svc:
            continue
        sid = svc["id"]
        matrix[sid] = {
            atk_id: {vic_id: 0 for vic_id in valid_team_ids if vic_id != atk_id}
            for atk_id in valid_team_ids
        }

    for ev in _safe_list(events_body.get("events")):
        if not isinstance(ev, dict) or ev.get("type") != "flag_captured":
            continue
        details = _safe_dict(ev.get("details"))
        atk_team = team_by_name.get(details.get("attacker"))
        vic_team = team_by_name.get(details.get("victim"))
        svc = service_by_name.get(details.get("service"))
        if not (atk_team and vic_team and svc):
            continue

        sid_bucket = matrix.get(svc["id"])
        if sid_bucket is None:
            continue
        atk_bucket = sid_bucket.get(atk_team["id"])
        if atk_bucket is None or vic_team["id"] not in atk_bucket:
            continue
        atk_bucket[vic_team["id"]] += 1

    return matrix


def _build_rankings(
    rankings_body: dict[str, Any],
    team_by_name: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """운영 포털 ``RankingEntry`` 리스트를 v2 프론트 기대 구조로 래핑.

    운영 포털 스키마에는 ``team_id``가 없어 ``team_name``으로 원본 팀을 찾아
    id/color를 복원한다.
    """
    v2: list[dict[str, Any]] = []
    for r in _safe_list(rankings_body.get("rankings")):
        if not isinstance(r, dict):
            continue
        team_name = r.get("team_name", "?")
        team = team_by_name.get(team_name, {"id": team_name, "name": team_name})
        v2.append({
            "team": {"id": team.get("id", team_name), "name": team.get("name", team_name)},
            "scores": {
                "attack": r.get("attack_score", 0),
                "defense": r.get("defense_score", 0),
                "bonus": 0,
            },
            "total": r.get("total_score", 0),
            "rank": r.get("rank", 0),
            "rank_change": r.get("rank_change", 0),
            "sla_percentage": r.get("sla_percentage", 0),
            "flags_captured": r.get("flags_captured", 0),
            "services_up": r.get("services_up", 0),
            "services_total": r.get("services_total", 0),
        })
    return v2
