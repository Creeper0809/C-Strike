import pytest

from app.utils.healthcheck_scenarios import normalize_healthcheck_scenarios


def test_normalize_healthcheck_scenarios_success():
    normalized = normalize_healthcheck_scenarios(
        {
            "version": 1,
            "steps": [
                {
                    "name": "login",
                    "request": {
                        "method": "POST",
                        "path": "/login",
                        "json_body": {"username": "demo", "password": "demo"},
                    },
                    "expect": {
                        "status": 200,
                        "json_paths_present": ["token"],
                    },
                }
            ],
        }
    )

    assert normalized is not None
    assert normalized["steps"][0]["request"]["method"] == "POST"
    assert normalized["steps"][0]["expect"]["status"] == 200


def test_normalize_healthcheck_scenarios_rejects_invalid_path():
    with pytest.raises(ValueError):
        normalize_healthcheck_scenarios(
            {
                "steps": [
                    {
                        "request": {"method": "GET", "path": "health"},
                        "expect": {"status": 200},
                    }
                ]
            }
        )
