from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request


BASE_DIR = Path("/app")
DATA_DIR = BASE_DIR / "data"
TEAM_INFO_PATH = DATA_DIR / "team-info.json"
MESSAGE_PATH = DATA_DIR / "messages.json"
FLAGS_DIR = Path("/flags")


def load_team_info() -> dict[str, str]:
    if TEAM_INFO_PATH.exists():
        try:
            return json.loads(TEAM_INFO_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {
        "team_name": "unknown-team",
        "team_code": "unknown-code",
        "service_name": "Pocket Guestbook",
        "team_subnet": "",
        "team_gateway_ip": "",
    }


def load_messages() -> list[dict[str, str]]:
    if not MESSAGE_PATH.exists():
        return [
            {
                "author": "system",
                "content": "Pocket Guestbook is ready.",
            }
        ]
    try:
        data = json.loads(MESSAGE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if isinstance(data, list):
        return [
            {
                "author": str(item.get("author", "guest")),
                "content": str(item.get("content", "")),
            }
            for item in data
            if isinstance(item, dict)
        ]
    return []


def save_messages(messages: list[dict[str, str]]) -> None:
    MESSAGE_PATH.write_text(
        json.dumps(messages, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_flags() -> list[dict[str, str]]:
    flags: list[dict[str, str]] = []
    if FLAGS_DIR.exists():
        for path in sorted(FLAGS_DIR.glob("*.txt")):
            try:
                value = path.read_text(encoding="utf-8").strip()
            except OSError:
                value = ""
            flags.append({"filename": path.name, "value": value})
    elif Path("/flag.txt").exists():
        try:
            value = Path("/flag.txt").read_text(encoding="utf-8").strip()
        except OSError:
            value = ""
        flags.append({"filename": "flag.txt", "value": value})
    return flags


app = Flask(__name__)


@app.get("/healthz")
def healthz():
    return "ok\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.get("/")
def index():
    return render_template(
        "index.html",
        team=load_team_info(),
        messages=load_messages(),
        flags=list_flags(),
    )


@app.get("/api/team-info")
def api_team_info():
    return jsonify(load_team_info())


@app.get("/api/messages")
def api_messages():
    return jsonify({"items": load_messages()})


@app.post("/api/messages")
def post_message():
    payload = request.get_json(silent=True) or {}
    author = str(payload.get("author") or "guest").strip()[:32]
    content = str(payload.get("content") or "").strip()[:200]
    if not content:
        return jsonify({"error": "content is required"}), 400

    messages = load_messages()
    messages.append({"author": author or "guest", "content": content})
    save_messages(messages)
    return jsonify({"ok": True, "item": messages[-1]}), 201


@app.get("/api/flags")
def api_flags():
    return jsonify({"items": list_flags()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
