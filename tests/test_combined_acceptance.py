import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "combined", Path(__file__).resolve().parents[1] / "scripts/acceptance-combined-recovery.py"
)
combined = importlib.util.module_from_spec(spec)
spec.loader.exec_module(combined)


class CleanupTests(unittest.TestCase):
    def test_passive_fixture_rejected_before_mutation_or_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "fixture.json").write_text(json.dumps({"notifications": "notify_only"}))
            with patch("sys.argv", ["combined", "--root", directory]), patch.object(combined.jobs, "Rpc") as rpc:
                with self.assertRaisesRegex(RuntimeError, "--notifications follow_up"):
                    combined.main()
                rpc.assert_not_called()
            self.assertEqual([p.name for p in root.iterdir()], ["fixture.json"])

    def test_broken_shutdown_pipe_still_closes_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            launch = project / ".piccolo/jobs/owned/launch.json"
            launch.parent.mkdir(parents=True)
            launch.write_text("{}")
            rpc = Mock()
            rpc.process.poll.side_effect = [None, 0, 0]
            rpc.send.side_effect = BrokenPipeError()
            checks = {}
            combined.shutdown(rpc, project, checks)
            rpc.request.assert_called_once_with("new_session")
            rpc.close.assert_called_once()
            self.assertTrue(checks["shutdown_request_failed"])
            self.assertFalse(checks["no_active_before_teardown"])
            self.assertFalse(checks["native_shutdown"])

    def test_failed_close_cannot_skip_owned_process_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            rpc = Mock()
            rpc.process.poll.side_effect = [None, None, -15]
            rpc.close.side_effect = BrokenPipeError()
            checks = {}
            combined.shutdown(rpc, Path(directory), checks)
            rpc.process.terminate.assert_called_once()
            rpc.process.wait.assert_called_once_with(timeout=10)
            rpc.selector.close.assert_called_once()
            rpc.log.close.assert_called_once()
            rpc.err.close.assert_called_once()
            self.assertTrue(checks["close_failed"])
            self.assertTrue(checks["forced_cleanup"])
            self.assertFalse(checks["native_shutdown"])


if __name__ == "__main__":
    unittest.main()
