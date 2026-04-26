"""Docker 네트워크 관리 — 팀별 격리 네트워크 생성/삭제/조회"""
import re

import docker


def _get_docker_client() -> docker.DockerClient:
    return docker.from_env()


def _safe_team_runtime_slug(team_code: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", (team_code or "").lower()).strip("-")
    return slug or "team"


def _network_name(team_code: str) -> str:
    return f"cstrike-team-{_safe_team_runtime_slug(team_code)}"


def ensure_team_network(
    team_code: str,
    subnet: str | None = None,
    gateway: str | None = None,
) -> dict:
    """팀 전용 bridge 네트워크를 생성하거나, 이미 존재하면 확인한다.

    Returns:
        네트워크 정보 dict (id, name, subnet, gateway)
    """
    client = _get_docker_client()
    name = _network_name(team_code)

    # 기존 네트워크 확인
    existing = client.networks.list(names=[name])
    for net in existing:
        if net.name == name:
            net.reload()
            ipam_configs = net.attrs.get("IPAM", {}).get("Config", [])
            existing_subnet = ipam_configs[0].get("Subnet") if ipam_configs else None
            existing_gateway = ipam_configs[0].get("Gateway") if ipam_configs else None
            return {
                "id": net.id,
                "name": net.name,
                "subnet": existing_subnet,
                "gateway": existing_gateway,
                "created": False,
            }

    # IPAM 설정 구성
    # 주의: docker-py IPAMPool 생성자는 소문자 인자(subnet/gateway/iprange/aux_addresses)만 받는다.
    # Docker Engine API 응답의 키는 대문자(Subnet/Gateway)지만, 파이썬 측 생성자는 소문자다.
    # 이전에 대문자로 넘겨 "IPAMPool.__init__() got an unexpected keyword argument 'Subnet'" 런타임 에러 발생.
    ipam_pool = None
    if subnet:
        pool_config: dict = {"subnet": subnet}
        if gateway:
            pool_config["gateway"] = gateway
        ipam_pool = docker.types.IPAMPool(**pool_config)

    ipam_config = None
    if ipam_pool:
        ipam_config = docker.types.IPAMConfig(pool_configs=[ipam_pool])

    # 새 네트워크 생성
    network = client.networks.create(
        name=name,
        driver="bridge",
        ipam=ipam_config,
        labels={
            "cstrike-managed": "true",
            "cstrike-team": team_code,
        },
    )

    return {
        "id": network.id,
        "name": network.name,
        "subnet": subnet,
        "gateway": gateway,
        "created": True,
    }


def remove_team_network(team_code: str) -> dict:
    """팀 네트워크를 삭제한다."""
    client = _get_docker_client()
    name = _network_name(team_code)

    existing = client.networks.list(names=[name])
    for net in existing:
        if net.name == name:
            net.remove()
            return {"name": name, "removed": True}

    return {"name": name, "removed": False, "message": "네트워크가 존재하지 않습니다"}


def list_team_networks() -> list[dict]:
    """cstrike-managed=true 라벨이 있는 네트워크 목록을 반환한다."""
    client = _get_docker_client()
    networks = client.networks.list(filters={"label": "cstrike-managed=true"})

    result = []
    for net in networks:
        net.reload()
        ipam_configs = net.attrs.get("IPAM", {}).get("Config", [])
        subnet = ipam_configs[0].get("Subnet") if ipam_configs else None
        gateway = ipam_configs[0].get("Gateway") if ipam_configs else None
        team_code = net.attrs.get("Labels", {}).get("cstrike-team", "")

        result.append({
            "id": net.id,
            "name": net.name,
            "team_code": team_code,
            "subnet": subnet,
            "gateway": gateway,
        })

    return result
