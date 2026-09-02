#!/usr/bin/env python3
"""Validate already-collected pairwise responses without calling a provider."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from codeasworld.pairwise_evaluator import evaluate_sanity_suite


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate_sanity_suite(json.loads(args.cases.read_text(encoding="utf-8")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
