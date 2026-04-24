"""MinIO 클라이언트 — 빌드 컨텍스트 파일 다운로드"""
import io
import os
import tarfile
import tempfile
from pathlib import Path

from minio import Minio

from app.config import settings

_client: Minio | None = None


def get_minio_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE,
        )
    return _client


def ensure_bucket():
    """버킷이 없으면 생성한다."""
    mc = get_minio_client()
    if not mc.bucket_exists(settings.MINIO_BUCKET):
        mc.make_bucket(settings.MINIO_BUCKET)
        print(f"[MinIO] 버킷 생성: {settings.MINIO_BUCKET}")
    else:
        print(f"[MinIO] 버킷 확인: {settings.MINIO_BUCKET}")


def download_build_context(service_id: str, target_dir: str) -> str:
    """MinIO에서 빌드 컨텍스트를 다운로드하여 target_dir에 저장한다.

    Returns:
        target_dir 경로 (Dockerfile이 있는 디렉토리)
    """
    mc = get_minio_client()
    prefix = f"build-context/{service_id}/"

    objects = mc.list_objects(settings.MINIO_BUCKET, prefix=prefix, recursive=True)
    file_count = 0

    for obj in objects:
        relative_path = obj.object_name[len(prefix):]
        if not relative_path:
            continue

        local_path = os.path.join(target_dir, relative_path)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

        mc.fget_object(settings.MINIO_BUCKET, obj.object_name, local_path)
        file_count += 1

    if file_count == 0:
        raise FileNotFoundError(f"빌드 컨텍스트가 비어있습니다: {prefix}")

    return target_dir


def create_build_tar(context_dir: str) -> io.BytesIO:
    """빌드 컨텍스트 디렉토리를 tar 아카이브로 만든다."""
    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w") as tar:
        for root, dirs, files in os.walk(context_dir):
            for f in files:
                full_path = os.path.join(root, f)
                arcname = os.path.relpath(full_path, context_dir)
                tar.add(full_path, arcname=arcname)
    tar_stream.seek(0)
    return tar_stream


def save_build_log(service_id: str, log_content: str):
    """빌드 로그를 MinIO에 저장한다."""
    from datetime import datetime, timezone

    mc = get_minio_client()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    object_name = f"build-logs/{service_id}/{timestamp}.log"

    data = log_content.encode("utf-8")
    mc.put_object(
        settings.MINIO_BUCKET,
        object_name,
        io.BytesIO(data),
        length=len(data),
        content_type="text/plain",
    )
