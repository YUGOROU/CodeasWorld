"""Fail-closed public/private observation and selection manifest contracts."""

from __future__ import annotations

from hashlib import sha256
import json
import re
from typing import Any


PUBLIC_SCHEMA = "codeasworld-model-public-observation-v1"
PRIVATE_SCHEMA = "codeasworld-evaluator-private-evidence-v1"
SELECTION_SCHEMA = "codeasworld-teacher-selection-manifest-v1"
DIAGNOSTIC_SCHEMA = "codeasworld-diagnostic-set-v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
CASE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class ObservationContractError(ValueError):
    pass


def canonical_sha256(value: dict[str, Any]) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _exact_keys(value: dict[str, Any], expected: set[str], field: str) -> None:
    if set(value) != expected:
        raise ObservationContractError(f"{field} keys must be exactly {sorted(expected)}")


def _artifact(value: Any, field: str, prefix: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ObservationContractError(f"{field} must be an artifact object")
    _exact_keys(value, {"path", "sha256"}, field)
    path, digest = value["path"], value["sha256"]
    if not isinstance(path, str) or not path.startswith(prefix) or path.startswith("/") or ".." in path.split("/"):
        raise ObservationContractError(f"{field}.path must remain under {prefix}")
    if not isinstance(digest, str) or SHA256.fullmatch(digest) is None:
        raise ObservationContractError(f"{field}.sha256 must be lowercase SHA-256")
    return value


def validate_public_observation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ObservationContractError("public observation must be an object")
    _exact_keys(value, {"schema_version", "case_id", "dataset_role", "source", "instruction", "rgb"}, "public observation")
    if value["schema_version"] != PUBLIC_SCHEMA:
        raise ObservationContractError("unsupported public observation schema")
    if not isinstance(value["case_id"], str) or CASE_ID.fullmatch(value["case_id"]) is None:
        raise ObservationContractError("invalid case_id")
    if value["dataset_role"] not in {"diagnostic_only", "teacher_selection"}:
        raise ObservationContractError("invalid dataset_role")
    source = value["source"]
    if not isinstance(source, dict):
        raise ObservationContractError("source must be an object")
    _exact_keys(source, {"repository", "revision", "split", "episode_id", "step_index", "camera_id", "privacy_status"}, "source")
    if not all(isinstance(source[key], str) and source[key] for key in ("repository", "revision", "split", "episode_id", "camera_id", "privacy_status")):
        raise ObservationContractError("source string fields must be non-empty")
    if isinstance(source["step_index"], bool) or not isinstance(source["step_index"], int) or source["step_index"] < 0:
        raise ObservationContractError("source.step_index must be non-negative")
    if not isinstance(value["instruction"], str):
        raise ObservationContractError("instruction must be a string")
    _artifact(value["rgb"], "rgb", "public/")
    return value


def validate_private_evidence(value: Any, public: dict[str, Any]) -> dict[str, Any]:
    validate_public_observation(public)
    if not isinstance(value, dict):
        raise ObservationContractError("private evidence must be an object")
    _exact_keys(value, {"schema_version", "scope", "case_id", "public_bundle_sha256", "synchronization", "views"}, "private evidence")
    if value["schema_version"] != PRIVATE_SCHEMA or value["scope"] != "evaluator_private":
        raise ObservationContractError("private evidence schema/scope mismatch")
    if value["case_id"] != public["case_id"] or value["public_bundle_sha256"] != canonical_sha256(public):
        raise ObservationContractError("private evidence is not bound to the public bundle")
    synchronization = value["synchronization"]
    if not isinstance(synchronization, dict):
        raise ObservationContractError("synchronization must be an object")
    _exact_keys(synchronization, {"status", "timestamp_tolerance_ms"}, "synchronization")
    if synchronization["status"] != "verified" or isinstance(synchronization["timestamp_tolerance_ms"], bool) or not isinstance(synchronization["timestamp_tolerance_ms"], int) or not 0 <= synchronization["timestamp_tolerance_ms"] <= 1000:
        raise ObservationContractError("private views must have verified bounded synchronization")
    views = value["views"]
    if not isinstance(views, list) or len(views) < 2:
        raise ObservationContractError("private evidence requires at least two synchronized views")
    ids: set[str] = set()
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            raise ObservationContractError(f"views[{index}] must be an object")
        _exact_keys(view, {"view_id", "timestamp_ns", "rgb", "depth", "calibration"}, f"views[{index}]")
        view_id = view["view_id"]
        if not isinstance(view_id, str) or not view_id or view_id in ids:
            raise ObservationContractError("private view IDs must be unique")
        ids.add(view_id)
        if isinstance(view["timestamp_ns"], bool) or not isinstance(view["timestamp_ns"], int) or view["timestamp_ns"] < 0:
            raise ObservationContractError("timestamp_ns must be non-negative")
        _artifact(view["rgb"], f"views[{index}].rgb", "evaluator-private/")
        _artifact(view["depth"], f"views[{index}].depth", "evaluator-private/")
        calibration = view["calibration"]
        if not isinstance(calibration, dict) or set(calibration) not in ({"status"}, {"status", "intrinsics", "extrinsics"}):
            raise ObservationContractError("calibration must declare unavailable or complete artifacts")
        if calibration["status"] == "available":
            if set(calibration) != {"status", "intrinsics", "extrinsics"}:
                raise ObservationContractError("available calibration requires intrinsics and extrinsics")
            _artifact(calibration["intrinsics"], "calibration.intrinsics", "evaluator-private/")
            _artifact(calibration["extrinsics"], "calibration.extrinsics", "evaluator-private/")
        elif calibration != {"status": "unavailable"}:
            raise ObservationContractError("unsupported calibration status")
    return value


def validate_diagnostic_set(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != DIAGNOSTIC_SCHEMA:
        raise ObservationContractError("unsupported diagnostic set schema")
    if value.get("role") != "diagnostic_only" or value.get("teacher_selection_eligible") is not False:
        raise ObservationContractError("diagnostic set must be ineligible for teacher selection")
    cases = value.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ObservationContractError("diagnostic set cases are required")
    ids = [case.get("case_id") for case in cases if isinstance(case, dict)]
    if len(ids) != len(cases) or len(set(ids)) != len(ids):
        raise ObservationContractError("diagnostic case IDs must be unique")
    return value


def validate_teacher_selection_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != SELECTION_SCHEMA:
        raise ObservationContractError("unsupported teacher selection schema")
    required = {"schema_version", "set_id", "role", "source", "seed", "grouping", "samples", "exclusions"}
    _exact_keys(value, required, "teacher selection manifest")
    if value["role"] != "teacher_selection" or isinstance(value["seed"], bool) or not isinstance(value["seed"], int) or value["seed"] < 0:
        raise ObservationContractError("teacher selection role/seed is invalid")
    if value["grouping"] not in {"scene", "building"}:
        raise ObservationContractError("grouping must be scene or building")
    if not isinstance(value["samples"], list) or not value["samples"]:
        raise ObservationContractError("teacher selection samples are required")
    ids = [sample.get("case_id") for sample in value["samples"] if isinstance(sample, dict)]
    if len(ids) != len(value["samples"]) or len(set(ids)) != len(ids):
        raise ObservationContractError("teacher selection case IDs must be unique")
    if not isinstance(value["exclusions"], list) or any(not isinstance(item, dict) or set(item) != {"source_id", "reason"} or not item["reason"] for item in value["exclusions"]):
        raise ObservationContractError("every exclusion must retain source_id and reason")
    return value
