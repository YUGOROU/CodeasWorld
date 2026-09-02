import unittest

from codeasworld.observation_contract import canonical_sha256
from codeasworld.pairwise_evaluator import PairwiseContractError, build_pairwise_request, evaluate_sanity_suite, evaluator_record, parse_pairwise_response
from tests.test_observation_contract import DIGEST, private, public


def candidate(candidate_id, role="student_candidate"):
    artifact = lambda suffix: {"path": f"candidates/{candidate_id}/{suffix}", "sha256": DIGEST}
    return {"candidate_id": candidate_id, "role": role, "world_code": artifact("scene.js"), "preview_render": artifact("preview.png"), "extracted_scene": artifact("extracted.json")}


def response(comparison_id, verdict):
    return {"schema_version": "codeasworld-pairwise-evaluator-response-v1", "comparison_id": comparison_id, "verdict": verdict, "rationale": "bounded physical-evidence comparison", "evidence_used": ["multi_view_rgb", "depth", "extracted_scene"], "invalid_reason": "missing evidence" if verdict == "INVALID" else None}


class PairwiseEvaluatorTests(unittest.TestCase):
    def test_request_treats_teacher_as_anchor_and_forbids_absolute_score(self):
        public_bundle = public(); private_bundle = private(public_bundle)
        request = build_pairwise_request(public_bundle, private_bundle, candidate("teacher", "teacher_anchor"), candidate("student"), comparison_id="cmp-1")
        self.assertFalse(request["judge_contract"]["teacher_is_ground_truth"])
        self.assertTrue(request["judge_contract"]["absolute_numeric_score_forbidden"])
        self.assertEqual(request["private_bundle_sha256"], canonical_sha256(private_bundle))

    def test_response_rejects_numeric_score_and_operational_failure_stays_separate(self):
        valid = response("cmp-1", "A_BETTER")
        self.assertEqual(parse_pairwise_response(valid)["verdict"], "A_BETTER")
        scored = dict(valid, score=0.9)
        with self.assertRaises(PairwiseContractError):
            parse_pairwise_response(scored)
        request = {"comparison_id": "cmp-1"}
        record = evaluator_record(request, provider="provider", model="model@rev", prompt_revision="p1", operational_error={"category": "rate_limit", "message": "429"})
        self.assertEqual(record["operational_status"], "OPERATIONAL_FAILURE")
        self.assertIsNone(record["judgment"])

    def test_complete_fixture_suite_checks_expected_and_swapped_verdicts(self):
        expected = {
            "obvious_corruption": "A_BETTER", "near_tie": "TIE", "visually_attractive_physically_wrong": "B_BETTER",
            "visually_rough_geometrically_correct": "A_BETTER", "teacher_better": "A_BETTER", "candidate_better_than_teacher": "B_BETTER",
        }
        cases = []
        inverse = {"A_BETTER": "B_BETTER", "B_BETTER": "A_BETTER", "TIE": "TIE", "INVALID": "INVALID"}
        for index, (scenario, verdict) in enumerate(expected.items()):
            cases.append({"scenario": scenario, "expected": verdict, "forward": response(f"cmp-{index}", verdict), "swapped": response(f"cmp-{index}-swap", inverse[verdict])})
        report = evaluate_sanity_suite(cases)
        self.assertTrue(report["coverage_complete"])
        self.assertTrue(report["swap_consistent"])
        self.assertTrue(report["go_for_reward_experiment"])

    def test_missing_scenario_is_no_go(self):
        cases = [{"scenario": "near_tie", "expected": "TIE", "forward": response("a", "TIE"), "swapped": response("b", "TIE")}]
        self.assertFalse(evaluate_sanity_suite(cases)["go_for_reward_experiment"])


if __name__ == "__main__":
    unittest.main()
