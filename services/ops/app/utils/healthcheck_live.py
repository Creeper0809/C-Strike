"""팀 서비스 헬스체크를 실시간으로 실행하는 유틸리티."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
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


def _build_not_run_steps(steps: list[dict[str, Any]], start_index: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for index in range(start_index, len(steps)):
        step = steps[index]
        request = step.get("request") or {}
        results.append(
            {
                "step_index": index,
                "name": str(step.get("name") or f"step-{index + 1}"),
                "request_label": f"{str(request.get('method') or 'GET').upper()} {str(request.get('path') or '/')}",
                "status": "not_run",
                "response_time_ms": None,
                "error_message": None,
            }
        )
    return results


async def run_scenario_healthcheck(
    base_url: str,
    scenarios: dict[str, Any],
) -> dict[str, Any]:
    normalized_base_url = str(base_url).rstrip("/")
    steps = scenarios.get("steps") or []
    checked_at = datetime.now(timezone.utc)

    if not steps:
        return {
            "check_type": "custom_script",
            "is_up": False,
            "response_time_ms": None,
            "error_message": "헬스체크 시나리오에 step이 없습니다.",
            "checked_at": checked_at,
            "steps": [],
        }

    started_at = time.monotonic()
    step_results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(base_url=normalized_base_url, verify=False) as client:
        for index, step in enumerate(steps):
            step_name = str(step.get("name") or f"step-{index + 1}")
            request = step.get("request") or {}
            expect = step.get("expect") or {}

            method = str(request.get("method") or "GET").upper()
            path = str(request.get("path") or "/")
            headers = request.get("headers") or {}
            params = request.get("query") or {}
            timeout = float(request.get("timeout_seconds") or 10.0)
            body = request.get("body")
            json_body = request.get("json_body")
            step_started_at = time.monotonic()
            request_label = f"{method} {path}"

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
                elapsed = int((time.monotonic() - step_started_at) * 1000)
                step_results.append(
                    {
                        "step_index": index,
                        "name": step_name,
                        "request_label": request_label,
                        "status": "failed",
                        "response_time_ms": elapsed,
                        "error_message": f"요청 타임아웃 ({timeout}초)",
                    }
                )
                step_results.extend(_build_not_run_steps(steps, index + 1))
                return {
                    "check_type": "custom_script",
                    "is_up": False,
                    "response_time_ms": int((time.monotonic() - started_at) * 1000),
                    "error_message": f"{step_name}: 요청 타임아웃 ({timeout}초)",
                    "checked_at": checked_at,
                    "steps": step_results,
                }
            except httpx.RequestError as exc:
                elapsed = int((time.monotonic() - step_started_at) * 1000)
                step_results.append(
                    {
                        "step_index": index,
                        "name": step_name,
                        "request_label": request_label,
                        "status": "failed",
                        "response_time_ms": elapsed,
                        "error_message": f"요청 실패 ({exc})",
                    }
                )
                step_results.extend(_build_not_run_steps(steps, index + 1))
                return {
                    "check_type": "custom_script",
                    "is_up": False,
                    "response_time_ms": int((time.monotonic() - started_at) * 1000),
                    "error_message": f"{step_name}: 요청 실패 ({exc})",
                    "checked_at": checked_at,
                    "steps": step_results,
                }

            text_body = response.text
            step_elapsed = int((time.monotonic() - step_started_at) * 1000)
            failure_reason: str | None = None

            expected_status = expect.get("status")
            expected_statuses = expect.get("status_in")
            if expected_status is not None and response.status_code != int(expected_status):
                failure_reason = (
                    f"상태코드 불일치 (expected {expected_status}, got {response.status_code})"
                )
            elif expected_statuses:
                normalized = {int(item) for item in expected_statuses}
                if response.status_code not in normalized:
                    failure_reason = (
                        f"상태코드 불일치 (expected one of {sorted(normalized)}, got {response.status_code})"
                    )

            if failure_reason is None:
                for needle in expect.get("body_contains") or []:
                    if str(needle) not in text_body:
                        failure_reason = f"응답 본문에 '{needle}'가 없습니다."
                        break

            if failure_reason is None:
                for needle in expect.get("body_not_contains") or []:
                    if str(needle) in text_body:
                        failure_reason = f"응답 본문에 '{needle}'가 포함되면 안 됩니다."
                        break

            if failure_reason is None:
                for header_name, expected_value in (expect.get("header_contains") or {}).items():
                    actual_value = response.headers.get(str(header_name), "")
                    if str(expected_value) not in actual_value:
                        failure_reason = f"헤더 {header_name}에 '{expected_value}'가 없습니다."
                        break

            payload: Any = None
            if failure_reason is None and (
                (expect.get("json_paths_present") or []) or (expect.get("json_path_equals") or {})
            ):
                try:
                    payload = response.json()
                except json.JSONDecodeError:
                    failure_reason = "JSON 응답 파싱 실패"

            if failure_reason is None and payload is not None:
                for path_name in expect.get("json_paths_present") or []:
                    exists, _ = _resolve_json_path(payload, str(path_name))
                    if not exists:
                        failure_reason = f"JSON 경로 '{path_name}'가 없습니다."
                        break

            if failure_reason is None and payload is not None:
                for path_name, expected_value in (expect.get("json_path_equals") or {}).items():
                    exists, actual_value = _resolve_json_path(payload, str(path_name))
                    if not exists:
                        failure_reason = f"JSON 경로 '{path_name}'가 없습니다."
                        break
                    if actual_value != expected_value:
                        failure_reason = (
                            f"JSON 경로 '{path_name}' 값 불일치 "
                            f"(expected {expected_value!r}, got {actual_value!r})"
                        )
                        break

            if failure_reason is not None:
                step_results.append(
                    {
                        "step_index": index,
                        "name": step_name,
                        "request_label": request_label,
                        "status": "failed",
                        "response_time_ms": step_elapsed,
                        "error_message": failure_reason,
                    }
                )
                step_results.extend(_build_not_run_steps(steps, index + 1))
                return {
                    "check_type": "custom_script",
                    "is_up": False,
                    "response_time_ms": int((time.monotonic() - started_at) * 1000),
                    "error_message": f"{step_name}: {failure_reason}",
                    "checked_at": checked_at,
                    "steps": step_results,
                }

            step_results.append(
                {
                    "step_index": index,
                    "name": step_name,
                    "request_label": request_label,
                    "status": "passed",
                    "response_time_ms": step_elapsed,
                    "error_message": None,
                }
            )

    return {
        "check_type": "custom_script",
        "is_up": True,
        "response_time_ms": int((time.monotonic() - started_at) * 1000),
        "error_message": None,
        "checked_at": checked_at,
        "steps": step_results,
    }


async def run_basic_http_healthcheck(host: str, port: int, endpoint: str) -> dict[str, Any]:
    url = f"http://{host}:{port}{endpoint}"
    checked_at = datetime.now(timezone.utc)
    started_at = time.monotonic()
    request_label = f"GET {endpoint}"
    try:
        async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
            response = await client.get(url)
        elapsed = int((time.monotonic() - started_at) * 1000)
        is_up = response.status_code == 200
        error_message = None if is_up else f"HTTP {response.status_code}"
        return {
            "check_type": "http_get",
            "is_up": is_up,
            "response_time_ms": elapsed,
            "error_message": error_message,
            "checked_at": checked_at,
            "steps": [
                {
                    "step_index": 0,
                    "name": "HTTP 엔드포인트 확인",
                    "request_label": request_label,
                    "status": "passed" if is_up else "failed",
                    "response_time_ms": elapsed,
                    "error_message": error_message,
                }
            ],
        }
    except httpx.TimeoutException:
        elapsed = int((time.monotonic() - started_at) * 1000)
        error_message = "HTTP 타임아웃 (10초)"
        return {
            "check_type": "http_get",
            "is_up": False,
            "response_time_ms": elapsed,
            "error_message": error_message,
            "checked_at": checked_at,
            "steps": [
                {
                    "step_index": 0,
                    "name": "HTTP 엔드포인트 확인",
                    "request_label": request_label,
                    "status": "failed",
                    "response_time_ms": elapsed,
                    "error_message": error_message,
                }
            ],
        }
    except httpx.RequestError as exc:
        elapsed = int((time.monotonic() - started_at) * 1000)
        error_message = f"HTTP 오류: {exc}"
        return {
            "check_type": "http_get",
            "is_up": False,
            "response_time_ms": elapsed,
            "error_message": error_message,
            "checked_at": checked_at,
            "steps": [
                {
                    "step_index": 0,
                    "name": "HTTP 엔드포인트 확인",
                    "request_label": request_label,
                    "status": "failed",
                    "response_time_ms": elapsed,
                    "error_message": error_message,
                }
            ],
        }


async def run_basic_tcp_healthcheck(host: str, port: int) -> dict[str, Any]:
    checked_at = datetime.now(timezone.utc)
    started_at = time.monotonic()
    request_label = f"TCP {host}:{port}"
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=10.0,
        )
        elapsed = int((time.monotonic() - started_at) * 1000)
        writer.close()
        await writer.wait_closed()
        return {
            "check_type": "tcp_connect",
            "is_up": True,
            "response_time_ms": elapsed,
            "error_message": None,
            "checked_at": checked_at,
            "steps": [
                {
                    "step_index": 0,
                    "name": "TCP 연결 확인",
                    "request_label": request_label,
                    "status": "passed",
                    "response_time_ms": elapsed,
                    "error_message": None,
                }
            ],
        }
    except asyncio.TimeoutError:
        elapsed = int((time.monotonic() - started_at) * 1000)
        error_message = "TCP 타임아웃 (10초)"
    except (ConnectionRefusedError, OSError) as exc:
        elapsed = int((time.monotonic() - started_at) * 1000)
        error_message = f"TCP 연결 실패: {exc}"

    return {
        "check_type": "tcp_connect",
        "is_up": False,
        "response_time_ms": elapsed,
        "error_message": error_message,
        "checked_at": checked_at,
        "steps": [
            {
                "step_index": 0,
                "name": "TCP 연결 확인",
                "request_label": request_label,
                "status": "failed",
                "response_time_ms": elapsed,
                "error_message": error_message,
            }
        ],
    }
