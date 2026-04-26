"""시나리오 기반 HTTP 헬스체크 실행기."""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urljoin

import httpx


def _split_json_path(path: str) -> list[str]:
    return [part for part in str(path).split(".") if part]


def _resolve_json_path(data: Any, path: str) -> tuple[bool, Any]:
    current = data
    for part in _split_json_path(path):
        if isinstance(current, list):
            try:
                index = int(part)
            except ValueError:
                return False, None
            if index < 0 or index >= len(current):
                return False, None
            current = current[index]
            continue

        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]

    return True, current


async def run_health_contract(
    base_url: str,
    scenarios: dict[str, Any],
) -> tuple[bool, int | None, str | None]:
    normalized_base_url = str(base_url).rstrip("/")
    steps = scenarios.get("steps") or []
    if not steps:
        return False, None, "헬스체크 시나리오에 step이 없습니다."

    started_at = time.monotonic()

    async with httpx.AsyncClient(base_url=normalized_base_url, verify=False) as client:
        for index, step in enumerate(steps, start=1):
            step_name = str(step.get("name") or f"step-{index}")
            request = step.get("request") or {}
            expect = step.get("expect") or {}

            method = str(request.get("method") or "GET").upper()
            path = str(request.get("path") or "/")
            headers = request.get("headers") or {}
            params = request.get("query") or {}
            timeout = float(request.get("timeout_seconds") or 10.0)
            body = request.get("body")
            json_body = request.get("json_body")

            try:
                response = await client.request(
                    method=method,
                    url=urljoin(f"{normalized_base_url}/", path.lstrip("/")),
                    headers=headers,
                    params=params,
                    content=None if body in (None, "") else str(body),
                    json=json_body,
                    timeout=timeout,
                )
            except httpx.TimeoutException:
                elapsed = int((time.monotonic() - started_at) * 1000)
                return False, elapsed, f"{step_name}: 요청 타임아웃 ({timeout}초)"
            except httpx.RequestError as exc:
                elapsed = int((time.monotonic() - started_at) * 1000)
                return False, elapsed, f"{step_name}: 요청 실패 ({exc})"

            text_body = response.text

            expected_status = expect.get("status")
            expected_statuses = expect.get("status_in")
            if expected_status is not None:
                if response.status_code != int(expected_status):
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, (
                        f"{step_name}: 상태코드 불일치 (expected {expected_status}, got {response.status_code})"
                    )
            elif expected_statuses:
                normalized = {int(item) for item in expected_statuses}
                if response.status_code not in normalized:
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, (
                        f"{step_name}: 상태코드 불일치 (expected one of {sorted(normalized)}, got {response.status_code})"
                    )

            for needle in expect.get("body_contains") or []:
                if str(needle) not in text_body:
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, f"{step_name}: 응답 본문에 '{needle}'가 없습니다."

            for needle in expect.get("body_not_contains") or []:
                if str(needle) in text_body:
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, f"{step_name}: 응답 본문에 '{needle}'가 포함되면 안 됩니다."

            for header_name, expected_value in (expect.get("header_contains") or {}).items():
                actual_value = response.headers.get(str(header_name), "")
                if str(expected_value) not in actual_value:
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, (
                        f"{step_name}: 헤더 {header_name}에 '{expected_value}'가 없습니다."
                    )

            if (expect.get("json_paths_present") or []) or (expect.get("json_path_equals") or {}):
                try:
                    payload = response.json()
                except json.JSONDecodeError:
                    elapsed = int((time.monotonic() - started_at) * 1000)
                    return False, elapsed, f"{step_name}: JSON 응답 파싱 실패"

                for path_name in expect.get("json_paths_present") or []:
                    exists, _ = _resolve_json_path(payload, str(path_name))
                    if not exists:
                        elapsed = int((time.monotonic() - started_at) * 1000)
                        return False, elapsed, f"{step_name}: JSON 경로 '{path_name}'가 없습니다."

                for path_name, expected_value in (expect.get("json_path_equals") or {}).items():
                    exists, actual_value = _resolve_json_path(payload, str(path_name))
                    if not exists:
                        elapsed = int((time.monotonic() - started_at) * 1000)
                        return False, elapsed, f"{step_name}: JSON 경로 '{path_name}'가 없습니다."
                    if actual_value != expected_value:
                        elapsed = int((time.monotonic() - started_at) * 1000)
                        return False, elapsed, (
                            f"{step_name}: JSON 경로 '{path_name}' 값 불일치 "
                            f"(expected {expected_value!r}, got {actual_value!r})"
                        )

    elapsed = int((time.monotonic() - started_at) * 1000)
    return True, elapsed, None
