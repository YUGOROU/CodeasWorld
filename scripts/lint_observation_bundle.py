#!/usr/bin/env python3
"""Validate model-public and evaluator-private observation artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from codeasworld.observation_contract import validate_private_evidence, validate_public_observation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--evaluator-private", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    public = json.loads(args.public.read_text(encoding="utf-8"))
    private = json.loads(args.evaluator_private.read_text(encoding="utf-8"))
    validate_public_observation(public)
    validate_private_evidence(private, public)
    report = {"status": "VALID", "case_id": public["case_id"], "model_public_artifacts": 1, "evaluator_private_views": len(private["views"]), "evaluator_private_depth_maps": len(private["views"])}
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output is None:
        print(rendered, end="")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
