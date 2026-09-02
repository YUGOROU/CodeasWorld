#!/usr/bin/env python3
"""Provider-free health check for the active CodeasWorld vertical slice."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import tempfile

from codeasworld.baseline import build_baseline_manifest, load_config
from codeasworld.observation_contract import canonical_sha256, validate_private_evidence, validate_public_observation
from codeasworld.pairwise_evaluator import evaluate_sanity_suite
from codeasworld.scene_projection import artifact_sha256, project_scene_to_mjcf, run_deterministic_rollout


def _digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def _response(identifier: str, verdict: str) -> dict[str, object]:
    return {
        "schema_version": "codeasworld-pairwise-evaluator-response-v1",
        "comparison_id": identifier,
        "verdict": verdict,
        "rationale": "provider-free fixture expectation",
        "evidence_used": ["multi_view_rgb", "depth", "extracted_scene"],
        "invalid_reason": None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    with tempfile.TemporaryDirectory(prefix="codeasworld-preflight-") as directory:
        work = Path(directory)
        render = work / "render.png"
        extraction = work / "extracted-scene.json"
        views = json.dumps([{"id": "main", "yaw": 0, "pitch": 0, "output_path": str(render)}])
        subprocess.run(
            ["node", str(root / "caw/three/render_driver.mjs"), str(root / "caw/tests/fixtures/extraction_scene.js"), str(render), views, str(root / "caw/assets/robocasa_manifest.json"), str(root / "caw/assets/materialized"), str(extraction)],
            cwd=root,
            check=True,
        )
        scene = json.loads(extraction.read_text(encoding="utf-8"))
        xml, projection = project_scene_to_mjcf(scene)
        first = run_deterministic_rollout(xml)
        second = run_deterministic_rollout(xml)
        if artifact_sha256(first) != artifact_sha256(second):
            raise SystemExit("MuJoCo rollout repeatability failed")

        digest = "a" * 64
        public = {
            "schema_version": "codeasworld-model-public-observation-v1", "case_id": "fixture-case", "dataset_role": "diagnostic_only",
            "source": {"repository": "local-fixture", "revision": "preflight-v1", "split": "fixture", "episode_id": "fixture", "step_index": 0, "camera_id": "main", "privacy_status": "synthetic_no_pii"},
            "instruction": "provider-free contract fixture", "rgb": {"path": "public/fixture/render.png", "sha256": _digest(render)},
        }
        view = lambda name: {"view_id": name, "timestamp_ns": 0, "rgb": {"path": f"evaluator-private/{name}.png", "sha256": digest}, "depth": {"path": f"evaluator-private/{name}.npy", "sha256": digest}, "calibration": {"status": "unavailable"}}
        private = {"schema_version": "codeasworld-evaluator-private-evidence-v1", "scope": "evaluator_private", "case_id": "fixture-case", "public_bundle_sha256": canonical_sha256(public), "synchronization": {"status": "verified", "timestamp_tolerance_ms": 0}, "views": [view("left"), view("right")]}
        validate_public_observation(public)
        validate_private_evidence(private, public)

        expectations = {
            "obvious_corruption": "A_BETTER", "near_tie": "TIE", "visually_attractive_physically_wrong": "B_BETTER",
            "visually_rough_geometrically_correct": "A_BETTER", "teacher_better": "A_BETTER", "candidate_better_than_teacher": "B_BETTER",
        }
        inverse = {"A_BETTER": "B_BETTER", "B_BETTER": "A_BETTER", "TIE": "TIE"}
        cases = [{"scenario": scenario, "expected": verdict, "forward": _response(f"{scenario}-forward", verdict), "swapped": _response(f"{scenario}-swapped", inverse[verdict])} for scenario, verdict in expectations.items()]
        sanity = evaluate_sanity_suite(cases)
        sanity["fixture_contract_pass"] = sanity.pop("go_for_reward_experiment")
        sanity["live_evaluator_go"] = False
        baseline = build_baseline_manifest(root, load_config(root / "config/active_baseline_files.json"))
        report = {
            "schema_version": "codeasworld-active-preflight-v1",
            "status": "PASS",
            "scope": "provider-free fixture only",
            "baseline": {"git": baseline["git"], "active_tree_sha256": baseline["active_tree_sha256"]},
            "threejs": {"render_sha256": _digest(render), "extracted_scene_sha256": _digest(extraction), "entity_count": len(scene["entities"])},
            "mujoco": {"projection": projection, "rollout_sha256": artifact_sha256(first), "repeatable": True},
            "observation_contract": {"public_artifacts": 1, "private_views": len(private["views"]), "depth_maps": len(private["views"])},
            "pairwise_fixture": sanity,
            "claims_not_established": ["DROID extraction quality", "SO-101 frame or action validity", "live Evaluator VLM validity", "human agreement", "teacher selection", "SFT/GRPO readiness", "real robot safety"],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
