#!/usr/bin/env python3
"""Project one extracted Three.js scene and run a bounded MuJoCo probe action."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from codeasworld.scene_projection import artifact_sha256, project_scene_to_mjcf, run_deterministic_rollout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extracted-scene", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--control", type=float, default=0.35)
    parser.add_argument("--steps", type=int, default=20)
    args = parser.parse_args()
    scene = json.loads(args.extracted_scene.read_text(encoding="utf-8"))
    xml, projection = project_scene_to_mjcf(scene)
    first = run_deterministic_rollout(xml, control=args.control, steps=args.steps)
    second = run_deterministic_rollout(xml, control=args.control, steps=args.steps)
    deterministic = artifact_sha256(first) == artifact_sha256(second)
    if not deterministic:
        raise SystemExit("fixed-seed rollout was not byte-for-byte deterministic")
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "projected.xml").write_text(xml, encoding="utf-8")
    (args.output / "projection.json").write_text(json.dumps(projection, indent=2) + "\n", encoding="utf-8")
    summary = {"projection": projection, "rollout": first, "repeatable": deterministic, "rollout_sha256": artifact_sha256(first)}
    (args.output / "rollout.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
