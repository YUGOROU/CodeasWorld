import unittest

from codeasworld.scene_projection import ProjectionError, artifact_sha256, project_scene_to_mjcf, run_deterministic_rollout, validate_extracted_scene


def fixture():
    return {
        "schema_version": "codeasworld-extracted-scene-v1",
        "units": "meter",
        "source": {"scene_code_sha256": "a" * 64},
        "entities": [
            {
                "id": "table", "name": "table", "parent_id": None, "physics": "static", "collision": "primitive", "asset_ref": None,
                "transform": {"position": [0, 0.4, 0], "quaternion_xyzw": [0, 0, 0, 1], "scale": [1, 1, 1]},
                "geometry": {"type": "BoxGeometry", "size": [1, 0.1, 0.8], "bounding_size": [1, 0.1, 0.8]},
            },
            {
                "id": "object", "name": "object", "parent_id": None, "physics": "dynamic", "collision": "primitive", "asset_ref": None,
                "transform": {"position": [0, 0.5, 0], "quaternion_xyzw": [0, 0, 0, 1], "scale": [1, 1, 1]},
                "geometry": {"type": "SphereGeometry", "radius": 0.03, "bounding_size": [0.06, 0.06, 0.06]},
            },
        ],
        "warnings": [],
    }


class SceneProjectionTests(unittest.TestCase):
    def test_projects_static_dynamic_and_fixed_probe_robot(self):
        xml, report = project_scene_to_mjcf(fixture())
        self.assertIn('name="caw_table"', xml)
        self.assertIn('name="free_object"', xml)
        self.assertIn('name="probe_position"', xml)
        self.assertEqual(report["projected_entity_ids"], ["table", "object"])
        self.assertFalse(report["robot"]["real_robot_ready"])

    def test_rejects_duplicate_ids_and_bad_quaternions(self):
        value = fixture()
        value["entities"].append(dict(value["entities"][0]))
        with self.assertRaises(ProjectionError):
            validate_extracted_scene(value)

    def test_fixed_probe_rollout_is_repeatable(self):
        xml, _ = project_scene_to_mjcf(fixture())
        first = run_deterministic_rollout(xml)
        second = run_deterministic_rollout(xml)
        self.assertEqual(artifact_sha256(first), artifact_sha256(second))
        self.assertNotEqual(first["initial_qpos"], first["final_qpos"])
        self.assertFalse(first["robot"]["real_robot_ready"])
        value = fixture()
        value["entities"][0]["transform"]["quaternion_xyzw"] = [0, 0, 0, 2]
        with self.assertRaises(ProjectionError):
            validate_extracted_scene(value)


if __name__ == "__main__":
    unittest.main()
