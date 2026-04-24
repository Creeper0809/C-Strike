"""스코어보드 v2 어댑터 단위 테스트.

운영 포털 실제 스키마(``current_round``, ``RankingEntry``에 ``team_id`` 없음,
``EventEntry.details``가 이름 기반, ``chart``가 ``{teams/rounds/scores}`` 구조)를
기반으로 빈 입력 안전성 + 핵심 변환 경로 5건을 검증한다.
"""

from state_adapter import build_state


def test_empty_input_returns_safe_structure():
    """빈 입력에서도 v2 기대 키가 모두 채워져야 한다."""
    result = build_state({})
    assert result["round"] == 0
    assert result["is_frozen"] is False
    assert result["rankings"] == []
    assert result["teams"] == []
    assert result["score_history"] == {}
    assert result["vulnpack_schedule"] == []
    assert result["services"] == []
    assert result["all_services"] == []
    assert result["attack_matrix"] == {}
    assert result["defense_record"] == {}
    assert result["bonus"] == {"problems": []}


def test_minimal_info_only():
    """info만 제공될 때 round/is_frozen/teams가 정상 매핑된다."""
    bundled = {
        "info": {
            "current_round": 5,
            "is_frozen": True,
            "teams": [{"id": "t1", "name": "Alpha", "color": "#ff0000"}],
            "services": [],
            "all_services": [],
            "vulnpacks": [],
        }
    }
    result = build_state(bundled)
    assert result["round"] == 5
    assert result["is_frozen"] is True
    assert result["teams"][0]["name"] == "Alpha"
    assert result["score_history"] == {"t1": []}


def test_attack_matrix_aggregation():
    """flag_captured 이벤트가 svc/atk/vic 버킷에 카운트되어야 한다.

    운영 포털 EventEntry는 details에 이름만 담으므로 어댑터가 이름 → id
    역매핑을 수행해야 한다.
    """
    bundled = {
        "info": {
            "teams": [
                {"id": "t1", "name": "A", "color": "#f00"},
                {"id": "t2", "name": "B", "color": "#0f0"},
            ],
            "all_services": [{"id": "svc1", "name": "WebShop", "category": "web"}],
        },
        "events": {
            "events": [
                {
                    "type": "flag_captured",
                    "details": {"attacker": "A", "victim": "B", "service": "WebShop"},
                },
                {
                    "type": "flag_captured",
                    "details": {"attacker": "A", "victim": "B", "service": "WebShop"},
                },
                {
                    "type": "sla_change",
                    "details": {
                        "team": "B",
                        "service": "WebShop",
                        "previous_status": True,
                        "current_status": False,
                    },
                },
            ]
        },
    }
    result = build_state(bundled)
    assert result["attack_matrix"]["svc1"]["t1"]["t2"] == 2
    assert result["attack_matrix"]["svc1"]["t2"]["t1"] == 0  # sla_change 무시


def test_rankings_wrapping():
    """RankingEntry가 v2 {team, scores, total} 래핑으로 변환되어야 한다.

    운영 포털은 team_id를 rankings에 담지 않으므로 team_name으로 info.teams
    를 역조회하여 id를 복원해야 한다.
    """
    bundled = {
        "info": {"teams": [{"id": "t1", "name": "Alpha", "color": "#f00"}]},
        "rankings": {
            "rankings": [
                {
                    "rank": 1,
                    "rank_change": 0,
                    "team_name": "Alpha",
                    "attack_score": 100,
                    "defense_score": 50,
                    "total_score": 170,
                    "sla_percentage": 95.5,
                    "flags_captured": 3,
                    "services_up": 2,
                    "services_total": 3,
                }
            ]
        },
    }
    result = build_state(bundled)
    assert len(result["rankings"]) == 1
    row = result["rankings"][0]
    assert row["team"]["id"] == "t1"
    assert row["team"]["name"] == "Alpha"
    assert row["scores"] == {"attack": 100, "defense": 50, "bonus": 0}
    assert row["total"] == 170
    assert row["rank"] == 1
    assert row["sla_percentage"] == 95.5


def test_score_history_from_chart():
    """chart.scores(team_name → list)가 team_id 기준 포인트 리스트로 변환된다."""
    bundled = {
        "info": {"teams": [{"id": "t1", "name": "Alpha", "color": "#f00"}]},
        "chart": {
            "teams": ["Alpha"],
            "rounds": [1, 2],
            "scores": {"Alpha": [10.0, 30.0]},
        },
    }
    result = build_state(bundled)
    assert result["score_history"]["t1"] == [
        {"round": 1, "total": 10.0},
        {"round": 2, "total": 30.0},
    ]
