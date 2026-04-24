"""SSH 원격 명령 실행 + SFTP 이미지 전송 모듈."""

import logging
import os
import tempfile
from dataclasses import dataclass

import paramiko

from app.config import settings

logger = logging.getLogger("deploy.ssh")


@dataclass
class SSHResult:
    """SSH 명령 실행 결과."""
    exit_code: int
    stdout: str
    stderr: str

    @property
    def success(self) -> bool:
        return self.exit_code == 0


class SSHExecutor:
    """팀 서버에 SSH로 접속하여 Docker 명령을 실행한다."""

    def __init__(self, host: str, port: int, user: str, password: str):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self._client: paramiko.SSHClient | None = None

    def connect(self) -> None:
        """SSH 연결을 수립한다."""
        self._client = paramiko.SSHClient()
        self._client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self._client.connect(
            hostname=self.host,
            port=self.port,
            username=self.user,
            password=self.password,
            timeout=settings.SSH_CONNECT_TIMEOUT,
            allow_agent=False,
            look_for_keys=False,
        )
        logger.info("SSH 연결 성공: %s@%s:%d", self.user, self.host, self.port)

    def close(self) -> None:
        """SSH 연결을 종료한다."""
        if self._client:
            self._client.close()
            self._client = None

    def exec(self, command: str, timeout: int | None = None) -> SSHResult:
        """원격 명령을 실행하고 결과를 반환한다."""
        if not self._client:
            raise RuntimeError("SSH 연결이 수립되지 않았습니다")
        effective_timeout = timeout or settings.SSH_COMMAND_TIMEOUT
        _, stdout_ch, stderr_ch = self._client.exec_command(
            command, timeout=effective_timeout,
        )
        exit_code = stdout_ch.channel.recv_exit_status()
        stdout = stdout_ch.read().decode(errors="replace")
        stderr = stderr_ch.read().decode(errors="replace")
        return SSHResult(exit_code=exit_code, stdout=stdout, stderr=stderr)

    def transfer_file(self, local_path: str, remote_path: str) -> None:
        """SFTP로 파일을 전송한다."""
        if not self._client:
            raise RuntimeError("SSH 연결이 수립되지 않았습니다")
        sftp = self._client.open_sftp()
        try:
            sftp.put(local_path, remote_path)
            logger.info("파일 전송 완료: %s -> %s:%s", local_path, self.host, remote_path)
        finally:
            sftp.close()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.close()


def save_docker_image(image_tag: str) -> str:
    """로컬 Docker 이미지를 tar 파일로 저장한다. 반환: tar 파일 경로."""
    import docker as docker_lib
    client = docker_lib.from_env()
    image = client.images.get(image_tag)

    tmp_dir = tempfile.mkdtemp(prefix="cstrike-img-")
    tar_path = os.path.join(tmp_dir, "image.tar")

    with open(tar_path, "wb") as f:
        for chunk in image.save(named=True):
            f.write(chunk)

    size_mb = os.path.getsize(tar_path) / (1024 * 1024)
    logger.info("이미지 저장 완료: %s (%.1f MB)", image_tag, size_mb)
    return tar_path


def validate_ssh_credentials(team) -> str | None:
    """팀의 SSH 자격 증명이 유효한지 검증한다. 오류 시 메시지 반환."""
    if not team.gateway_ip:
        return f"팀 {team.team_code}: gateway_ip(SSH 호스트) 미설정"
    if not team.ssh_user:
        return f"팀 {team.team_code}: SSH 사용자 미설정"
    if not team.ssh_password:
        return f"팀 {team.team_code}: SSH 비밀번호 미설정"
    return None
