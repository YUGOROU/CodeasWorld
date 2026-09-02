import unittest

from codeasworld.observation_contract import ObservationContractError, canonical_sha256, validate_diagnostic_set, validate_private_evidence, validate_public_observation, validate_teacher_selection_manifest


DIGEST = "a" * 64


def public():
    return {
        "schema_version": "codeasworld-model-public-observation-v1", "case_id": "case-00", "dataset_role": "diagnostic_only",
        "source": {"repository": "dataset", "revision": "rev", "split": "train", "episode_id": "0", "step_index": 0, "camera_id": "left", "privacy_status": "face_blurred_verified"},
        "instruction": "move object", "rgb": {"path": "public/case-00/input.png", "sha256": DIGEST},
    }


def private(public_bundle):
    view = lambda name: {
        "view_id": name, "timestamp_ns": 10, "rgb": {"path": f"evaluator-private/{name}.png", "sha256": DIGEST},
        "depth": {"path": f"evaluator-private/{name}.npy", "sha256": DIGEST}, "calibration": {"status": "unavailable"},
    }
    return {"schema_version": "codeasworld-evaluator-private-evidence-v1", "scope": "evaluator_private", "case_id": "case-00", "public_bundle_sha256": canonical_sha256(public_bundle), "synchronization": {"status": "verified", "timestamp_tolerance_ms": 5}, "views": [view("left"), view("right")]}


class ObservationContractTests(unittest.TestCase):
    def test_public_contract_allows_only_single_rgb_artifact(self):
        self.assertEqual(validate_public_observation(public())["rgb"]["path"], "public/case-00/input.png")
        leaked = public(); leaked["depth"] = {"path": "evaluator-private/depth.npy", "sha256": DIGEST}
        with self.assertRaises(ObservationContractError):
            validate_public_observation(leaked)

    def test_private_bundle_is_hash_bound_and_requires_multiview_depth(self):
        public_bundle = public(); evidence = private(public_bundle)
        self.assertEqual(len(validate_private_evidence(evidence, public_bundle)["views"]), 2)
        evidence["views"][0]["rgb"]["path"] = "public/leak.png"
        with self.assertRaises(ObservationContractError):
            validate_private_evidence(evidence, public_bundle)
        evidence = private(public_bundle); evidence["public_bundle_sha256"] = "b" * 64
        with self.assertRaises(ObservationContractError):
            validate_private_evidence(evidence, public_bundle)

    def test_teacher_selection_requires_seed_grouping_and_exclusion_reasons(self):
        manifest = {"schema_version": "codeasworld-teacher-selection-manifest-v1", "set_id": "seeded-v1", "role": "teacher_selection", "source": {"revision": "rev"}, "seed": 42, "grouping": "building", "samples": [{"case_id": "case-a"}], "exclusions": [{"source_id": "bad", "reason": "decode_failure"}]}
        self.assertEqual(validate_teacher_selection_manifest(manifest)["seed"], 42)
        manifest["exclusions"][0]["reason"] = ""
        with self.assertRaises(ObservationContractError):
            validate_teacher_selection_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
