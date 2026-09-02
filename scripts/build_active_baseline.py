#!/usr/bin/env python3
"""Write an immutable manifest for the current active CodeasWorld sources."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from codeasworld.baseline import build_baseline_manifest, load_config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    config_path = args.config or root / "config" / "active_baseline_files.json"
    manifest = build_baseline_manifest(root, load_config(config_path))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
