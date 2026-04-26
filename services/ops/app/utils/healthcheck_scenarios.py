"""서비스 헬스체크 시나리오 정규화 유틸리티."""

from __future__ import annotations

import json
from typing import Any


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}

DEFAULT_HEALTHCHECK_SCENARIO_TEMPLATE: dict[str, Any] = {
    "version": 1,
    "steps": [
        {
            "name": "루트 페이지 확인",
            "request": {
                "method": "GET",
                "path": "/",
            },
            "expect": {
                "status": 200,
                "body_contains": [
                    "Index of /",
                ],
            },
        },
        {
            "name": "팀 정보 파일 확인",
            "request": {
                "method": "GET",
                "path": "/team-info.txt",
            },
            "expect": {
                "status": 200,
                "body_contains": [
                    "team_name=",
                    "team_code=",
                ],
            },
        },
    ],
}


def build_healthcheck_scenario_template_json() -> str:
    return json.dumps(DEFAULT_HEALTHCHECK_SCENARIO_TEMPLATE, ensure_ascii=False, indent=2)


def _normalize_string_dict(raw: Any, field_name: str) -> dict[str, str]:
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict):
        raise ValueError(f"{field_name}는 key/value 객체여야 합니다.")
    normalized: dict[str, str] = {}
    for key, value in raw.items():
        normalized[str(key)] = str(value)
    return normalized


def _normalize_status_expectation(raw_expect: dict[str, Any]) -> tuple[int | None, list[int] | None]:
    status = raw_expect.get("status")
    status_in = raw_expect.get("status_in")

    if status in ("", []):
        status = None
    if status_in in ("", []):
        status_in = None

    if status is not None and status_in is not None:
        raise ValueError("expect.status와 expect.status_in은 동시에 사용할 수 없습니다.")

    if status is None and status_in is None:
        return 200, None

    if status is not None:
        try:
            value = int(status)
        except (TypeError, ValueError) as exc:
            raise ValueError("expect.status는 숫자여야 합니다.") from exc
        return value, None

    if not isinstance(status_in, list) or not status_in:
        raise ValueError("expect.status_in은 비어 있지 않은 숫자 배열이어야 합니다.")
    normalized_list: list[int] = []
    for item in status_in:
        try:
            normalized_list.append(int(item))
        except (TypeError, ValueError) as exc:
            raise ValueError("expect.status_in에는 숫자만 들어갈 수 있습니다.") from exc
    return None, normalized_list


def _normalize_string_list(raw: Any, field_name: str) -> list[str]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise ValueError(f"{field_name}는 문자열 배열이어야 합니다.")
    return [str(item) for item in raw]


def normalize_healthcheck_scenarios(raw_config: Any) -> dict[str, Any] | None:
    if raw_config in (None, "", []):
        return None

    config = raw_config
    if isinstance(config, list):
        config = {"version": 1, "steps": config}
    if not isinstance(config, dict):
        raise ValueError("헬스체크 시나리오는 JSON 객체 또는 steps 배열이어야 합니다.")

    raw_steps = config.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("헬스체크 시나리오에는 최소 1개 이상의 step이 필요합니다.")

    normalized_steps: list[dict[str, Any]] = []

    for index, raw_step in enumerate(raw_steps, start=1):
        if not isinstance(raw_step, dict):
            raise ValueError(f"{index}번째 step 형식이 올바르지 않습니다.")

        request = raw_step.get("request")
        expect = raw_step.get("expect")
        if not isinstance(request, dict):
            raise ValueError(f"{index}번째 step의 request가 필요합니다.")
        if not isinstance(expect, dict):
            raise ValueError(f"{index}번째 step의 expect가 필요합니다.")

        method = str(request.get("method") or "GET").upper()
        if method not in HTTP_METHODS:
            raise ValueError(f"{index}번째 step의 request.method는 지원되지 않습니다: {method}")

        path = str(request.get("path") or "").strip()
        if not path.startswith("/"):
            raise ValueError(f"{index}번째 step의 request.path는 '/'로 시작해야 합니다.")

        body = request.get("body")
        json_body = request.get("json_body")
        if body not in (None, "") and json_body is not None:
            raise ValueError(f"{index}번째 step은 body와 json_body를 동시에 사용할 수 없습니다.")

        timeout_seconds = request.get("timeout_seconds", 10)
        try:
            timeout_value = float(timeout_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{index}번째 step의 timeout_seconds 형식이 올바르지 않습니다.") from exc
        if timeout_value <= 0 or timeout_value > 60:
            raise ValueError(f"{index}번째 step의 timeout_seconds는 0보다 크고 60 이하여야 합니다.")

        status, status_in = _normalize_status_expectation(expect)

        normalized_steps.append(
            {
                "name": str(raw_step.get("name") or f"step-{index}").strip() or f"step-{index}",
                "request": {
                    "method": method,
                    "path": path,
                    "query": _normalize_string_dict(request.get("query"), f"{index}번째 step의 request.query"),
                    "headers": _normalize_string_dict(request.get("headers"), f"{index}번째 step의 request.headers"),
                    "body": None if body in (None, "") else str(body),
                    "json_body": json_body,
                    "timeout_seconds": timeout_value,
                },
                "expect": {
                    "status": status,
                    "status_in": status_in,
                    "body_contains": _normalize_string_list(expect.get("body_contains"), f"{index}번째 step의 expect.body_contains"),
                    "body_not_contains": _normalize_string_list(expect.get("body_not_contains"), f"{index}번째 step의 expect.body_not_contains"),
                    "header_contains": _normalize_string_dict(expect.get("header_contains"), f"{index}번째 step의 expect.header_contains"),
                    "json_paths_present": _normalize_string_list(expect.get("json_paths_present"), f"{index}번째 step의 expect.json_paths_present"),
                    "json_path_equals": expect.get("json_path_equals") or {},
                },
            }
        )

    return {
        "version": int(config.get("version") or 1),
        "steps": normalized_steps,
    }
