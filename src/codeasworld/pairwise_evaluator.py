"""Provider-neutral pairwise VLM evaluator contract and sanity gates."""

from __future__ import annotations

from hashlib import sha256
import json
import re
from typing import Any

from .observation_contract import canonical_sha256, validate_private_evidence, validate_public_observation


REQUEST_SCHEMA = "codeasworld-pairwise-evaluator-request-v1"
RESPONSE_SCHEMA = "codeasworld-pairwise-evaluator-response-v1"
RECORD_SCHEMA = "codeasworld-pairwise-evaluator-record-v1"
SUITE_SCHEMA = "codeasworld-pairwise-sanity-suite-v1"
VERDICTS = {"A_BETTER", "B_BETTER", "TIE", "INVALID"}
EVIDENCE_TYPES = {"multi_view_rgb", "depth", "camera_calibration", "world_code", "preview_render", "extracted_scene"}
REQUIRED_SCENARIOS = {
    "obvious_corruption",
    "near_tie",
    "visually_attractive_physically_wrong",
    "visually_rough_geometrically_correct",
    "teacher_better",
    "candidate_better_than_teacher",
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class PairwiseContractError(ValueError):
    pass


def _exact(value: dict[str, Any], expected: set[str], field: str) -> None:
    if set(value) != expected:
        raise PairwiseContractError(f"{field} keys must be exactly {sorted(expected)}")


def _candidate(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PairwiseContractError(f"{field} must be an object")
    _exact(value, {"candidate_id", "role", "world_code", "preview_render", "extracted_scene"}, field)
    if not isinstance(value["candidate_id"], str) or not value["candidate_id"]:
        raise PairwiseContractError(f"{field}.candidate_id is required")
    if value["role"] not in {"teacher_anchor", "student_candidate", "control"}:
        raise PairwiseContractError(f"{field}.role is invalid")
    for name in ("world_code", "preview_render", "extracted_scene"):
        artifact = value[name]
        if not isinstance(artifact, dict) or set(artifact) != {"path", "sha256"}:
            raise PairwiseContractError(f"{field}.{name} must be an artifact reference")
        if not isinstance(artifact["path"], str) or artifact["path"].startswith("/") or ".." in artifact["path"].split("/"):
            raise PairwiseContractError(f"{field}.{name}.path must be relative and root-safe")
        if not isinstance(artifact["sha256"], str) or SHA256.fullmatch(artifact["sha256"]) is None:
            raise PairwiseContractError(f"{field}.{name}.sha256 is invalid")
    return value


def build_pairwise_request(
    public: dict[str, Any],
    private: dict[str, Any],
    candidate_a: dict[str, Any],
    candidate_b: dict[str, Any],
    *,
    comparison_id: str,
) -> dict[str, Any]:
    validate_public_observation(public)
    validate_private_evidence(private, public)
    _candidate(candidate_a, "candidate_a")
    _candidate(candidate_b, "candidate_b")
    if candidate_a["candidate_id"] == candidate_b["candidate_id"]:
        raise PairwiseContractError("pairwise comparison requires distinct candidates")
    if not isinstance(comparison_id, str) or not comparison_id:
        raise PairwiseContractError("comparison_id is required")
    return {
        "schema_version": REQUEST_SCHEMA,
        "comparison_id": comparison_id,
        "case_id": public["case_id"],
        "public_bundle_sha256": canonical_sha256(public),
        "private_bundle_sha256": canonical_sha256(private),
        "judge_contract": {
            "objective": "Prefer the candidate that better reconstructs the physical world evidenced by hidden synchronized views and depth; code style and teacher identity are irrelevant.",
            "allowed_verdicts": ["A_BETTER", "B_BETTER", "TIE", "INVALID"],
            "absolute_numeric_score_forbidden": True,
            "teacher_is_ground_truth": False,
        },
        "candidate_a": candidate_a,
        "candidate_b": candidate_b,
    }


def parse_pairwise_response(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PairwiseContractError("evaluator response must be an object")
    _exact(value, {"schema_version", "comparison_id", "verdict", "rationale", "evidence_used", "invalid_reason"}, "evaluator response")
    if value["schema_version"] != RESPONSE_SCHEMA or not isinstance(value["comparison_id"], str) or not value["comparison_id"]:
        raise PairwiseContractError("response schema/comparison_id is invalid")
    if value["verdict"] not in VERDICTS:
        raise PairwiseContractError("unsupported pairwise verdict")
    if not isinstance(value["rationale"], str) or not 1 <= len(value["rationale"]) <= 2000:
        raise PairwiseContractError("rationale must be bounded non-empty text")
    evidence = value["evidence_used"]
    if not isinstance(evidence, list) or not evidence or any(item not in EVIDENCE_TYPES for item in evidence) or len(set(evidence)) != len(evidence):
        raise PairwiseContractError("evidence_used is invalid")
    invalid_reason = value["invalid_reason"]
    if value["verdict"] == "INVALID":
        if not isinstance(invalid_reason, str) or not invalid_reason:
            raise PairwiseContractError("INVALID requires invalid_reason")
    elif invalid_reason is not None:
        raise PairwiseContractError("non-INVALID verdict must use null invalid_reason")
    return value


def evaluator_record(
    request: dict[str, Any],
    *,
    provider: str,
    model: str,
    prompt_revision: str,
    response: dict[str, Any] | None = None,
    operational_error: dict[str, str] | None = None,
) -> dict[str, Any]:
    if (response is None) == (operational_error is None):
        raise PairwiseContractError("record requires exactly one response or operational_error")
    if not all(isinstance(item, str) and item for item in (provider, model, prompt_revision)):
        raise PairwiseContractError("provider/model/prompt revision are required")
    if response is not None:
        parse_pairwise_response(response)
        if response["comparison_id"] != request.get("comparison_id"):
            raise PairwiseContractError("response comparison_id mismatch")
    else:
        if not isinstance(operational_error, dict) or set(operational_error) != {"category", "message"} or not all(isinstance(item, str) and item for item in operational_error.values()):
            raise PairwiseContractError("operational_error must contain category and message")
    return {
        "schema_version": RECORD_SCHEMA,
        "comparison_id": request.get("comparison_id"),
        "request_sha256": canonical_sha256(request),
        "provider": provider,
        "model": model,
        "prompt_revision": prompt_revision,
        "operational_status": "COMPLETED" if response is not None else "OPERATIONAL_FAILURE",
        "judgment": response,
        "operational_error": operational_error,
    }


def swapped_verdict(verdict: str) -> str:
    return {"A_BETTER": "B_BETTER", "B_BETTER": "A_BETTER", "TIE": "TIE", "INVALID": "INVALID"}[verdict]


def evaluate_sanity_suite(cases: list[dict[str, Any]]) -> dict[str, Any]:
    scenario_results: dict[str, bool] = {}
    swap_results: list[bool] = []
    for case in cases:
        if not isinstance(case, dict) or set(case) != {"scenario", "expected", "forward", "swapped"}:
            raise PairwiseContractError("sanity case has invalid fields")
        if case["scenario"] not in REQUIRED_SCENARIOS or case["expected"] not in VERDICTS:
            raise PairwiseContractError("sanity case scenario/expected is invalid")
        forward = parse_pairwise_response(case["forward"])["verdict"]
        swapped = parse_pairwise_response(case["swapped"])["verdict"]
        scenario_results[case["scenario"]] = forward == case["expected"]
        swap_results.append(swapped == swapped_verdict(forward))
    coverage = set(scenario_results) == REQUIRED_SCENARIOS
    all_expected = coverage and all(scenario_results.values())
    swap_consistent = bool(swap_results) and all(swap_results)
    return {
        "schema_version": SUITE_SCHEMA,
        "required_scenarios": sorted(REQUIRED_SCENARIOS),
        "scenario_results": scenario_results,
        "coverage_complete": coverage,
        "all_expected": all_expected,
        "swap_consistent": swap_consistent,
        "go_for_reward_experiment": all_expected and swap_consistent,
        "limitations": ["fixture/provider-specific evidence only", "does not establish human agreement or reward robustness"],
    }
