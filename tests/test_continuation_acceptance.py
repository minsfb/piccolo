import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("continuation", Path(__file__).resolve().parents[1] / "scripts/acceptance-continuation.py")
continuation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(continuation)


class HandledParentTests(unittest.TestCase):
    def test_refusal_final_is_observed_without_requiring_success_codeword(self):
        final = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "Recovery could not be verified."}]}}
        for disposition in ["resolved", "development"]:
            handled = {"type": "tool_execution_end", "toolName": "harness_health", "isError": False, "result": {"details": {"incidents": [{"disposition": disposition}]}}}
            self.assertEqual(continuation.parent_final_after_disposition([final, handled]), -1)
            self.assertEqual(continuation.parent_final_after_disposition([final, handled, final]), 2)
            handled["isError"] = True
            self.assertEqual(continuation.parent_final_after_disposition([handled, final]), -1)

    def test_open_incident_or_initial_final_is_not_completion(self):
        final = {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop"}}
        opened = {"type": "tool_execution_end", "toolName": "harness_health", "result": {"details": {"incidents": [{"disposition": "open"}]}}}
        self.assertEqual(continuation.parent_final_after_disposition([]), -1)
        self.assertEqual(continuation.parent_final_after_disposition([final]), -1)
        self.assertEqual(continuation.parent_final_after_disposition([opened, final]), -1)
