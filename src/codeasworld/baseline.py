"""Reproducible source manifest for the active CodeasWorld path."""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import subprocess
from typing import Iterable


SCHEMA_VERSION = "codeasworld-active-baseline-v1"


def _sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _files(root: Path, paths: Iterable[str]) -> list[Path]:
    result: list[Path] = []
    for relative in paths:
        candidate = root / relative
        if candidate.is_file():
            result.append(candidate)
        elif candidate.is_dir():
            result.extend(path for path in candidate.rglob("*") if path.is_file())
        else:
            raise FileNotFoundError(f"baseline path does not exist: {relative}")
    return sorted(set(result), key=lambda path: path.relative_to(root).as_posix())


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    )
    return completed.stdout.strip()


def build_baseline_manifest(root: Path, config: dict[str, object]) -> dict[str, object]:
    root = root.resolve()
    active = config.get("active_paths")
    if not isinstance(active, list) or not active or not all(isinstance(item, str) for item in active):
        raise ValueError("active_paths must be a non-empty list of strings")
    records = [
        {
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
        for path in _files(root, active)
    ]
    tree_digest = sha256(
        "".join(f"{item['path']}\0{item['sha256']}\n" for item in records).encode()
    ).hexdigest()
    status = _git(root, "status", "--short", "--untracked-files=all")
    return {
        "schema_version": SCHEMA_VERSION,
        "git": {
            "head": _git(root, "rev-parse", "HEAD"),
            "branch": _git(root, "branch", "--show-current"),
            "dirty": bool(status),
            "status": status.splitlines(),
        },
        "classification": {
            key: config.get(key, [])
            for key in ("active_paths", "deferred_paths", "historical_paths")
        },
        "files": records,
        "active_tree_sha256": tree_digest,
    }


def load_config(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema_version") != "codeasworld-active-baseline-inputs-v1":
        raise ValueError("unsupported baseline input schema")
    return value
