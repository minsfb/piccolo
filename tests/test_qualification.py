"""Offline regression checks for evidence attribution; no Pi or credentials used."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).parents[1]/"scripts/qualify-v0.1.py")
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class AttributionTests(unittest.TestCase):
    def test_execution_path_requires_one_explicit_launch(self):
        launch = {"type": "tool_execution_start", "toolName": "subagent",
                  "args": {"agent": "delegate", "async": False}}
        self.assertTrue(qualification.requested_execution_path([launch], False))
        self.assertFalse(qualification.requested_execution_path([], False))
        self.assertFalse(qualification.requested_execution_path([launch, launch], False))
        self.assertFalse(qualification.requested_execution_path([launch], True))
        poll = {"type": "tool_execution_start", "toolName": "subagent", "args": {"action": "status"}}
        self.assertFalse(qualification.requested_execution_path([launch, poll], False))
        launch["args"]["async"] = True
        self.assertTrue(qualification.requested_execution_path([launch, poll], True))
        launch["args"].pop("async")
        self.assertFalse(qualification.requested_execution_path([launch], False))

    def test_claimed_model_cannot_replace_child_session_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            session = root/"child.jsonl"
            session.write_text("\n".join(json.dumps(e) for e in [
                {"type": "session", "cwd": str(root)},
                {"type": "message", "message": {"role": "toolResult", "toolName": "write", "isError": False}},
                {"type": "message", "message": {"role": "assistant", "provider": "a", "model": "actual", "stopReason": "stop"}},
            ]))
            stream = [{"type": "tool_execution_end", "result": {"details": {"results": [
                {"model": "a/claimed", "sessionFile": str(session), "exitCode": 0}
            ]}}}]
            result = qualification.child_evidence(stream, root, "a/claimed")
            self.assertFalse(result[0]["checks"]["expected_model"])
            self.assertEqual(result[0]["models"], ["a/actual"])
            self.assertTrue(qualification.child_evidence(stream, root, "a/actual")[0]["checks"]["expected_model"])

    def test_missing_session_is_not_evidence(self):
        self.assertEqual(qualification.child_evidence([
            {"type": "tool_execution_end", "result": {"details": {"results": [{"model": "a/claimed", "exitCode": 0}]}}}
        ], Path("/tmp"), "a/claimed"), [])

    def test_non_event_banner_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"stdout.jsonl"
            path.write_text('Pi banner\n{"type":"agent_end"}\nnot json\n[]\n')
            self.assertEqual(qualification.events(path), [{"type": "agent_end"}])


if __name__ == "__main__":
    unittest.main()
