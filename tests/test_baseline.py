import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from codeasworld.baseline import SCHEMA_VERSION, build_baseline_manifest


class BaselineManifestTests(unittest.TestCase):
    def test_manifest_hashes_active_files_and_records_git_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            (root / "active").mkdir()
            (root / "active" / "a.txt").write_text("a\n", encoding="utf-8")
            (root / "active" / "b.txt").write_text("b\n", encoding="utf-8")
            subprocess.run(["git", "add", "active"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
            manifest = build_baseline_manifest(root, {"active_paths": ["active"]})
            self.assertEqual(manifest["schema_version"], SCHEMA_VERSION)
            self.assertFalse(manifest["git"]["dirty"])
            self.assertEqual([item["path"] for item in manifest["files"]], ["active/a.txt", "active/b.txt"])
            self.assertEqual(len(manifest["active_tree_sha256"]), 64)

    def test_missing_active_path_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            with self.assertRaises(FileNotFoundError):
                build_baseline_manifest(root, {"active_paths": ["missing"]})


if __name__ == "__main__":
    unittest.main()
