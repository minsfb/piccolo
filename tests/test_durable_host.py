import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


HOST = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "durable-host.py"


class DurableHostTest(unittest.TestCase):
    def run_host(self, script):
        with tempfile.TemporaryDirectory(prefix="piccolo-host-") as directory:
            child = pathlib.Path(directory) / "fixture.py"
            child.write_text(script)
            result = subprocess.run(
                [sys.executable, str(HOST), "--", sys.executable, str(child)],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return [json.loads(line) for line in result.stdout.splitlines()]

    def test_close_event_closes_rpc_input(self):
        events = self.run_host('''import json, sys
print(json.dumps({"type": "unrelated_rpc_event"}), flush=True)
print(json.dumps({"type": "piccolo_worker_ready"}), flush=True)
print(json.dumps({"type": "piccolo_worker_closed"}), flush=True)
assert sys.stdin.read() == ""
''')
        self.assertEqual([event["type"] for event in events], ["piccolo_worker_ready", "piccolo_worker_closed"])

    def test_startup_error_closes_rpc_input(self):
        events = self.run_host('''import json, sys
print(json.dumps({"type": "piccolo_worker_error", "error": "fixture startup failure"}), flush=True)
assert sys.stdin.read() == ""
''')
        self.assertEqual(events, [{"type": "piccolo_worker_error", "error": "fixture startup failure"}])

    def test_managed_extension_events_on_stderr(self):
        events = self.run_host('''import json, sys
print("managed launcher diagnostic", file=sys.stderr, flush=True)
print(json.dumps({"type": "piccolo_worker_ready"}), file=sys.stderr, flush=True)
print(json.dumps({"type": "piccolo_worker_closed"}), file=sys.stderr, flush=True)
assert sys.stdin.read() == ""
''')
        self.assertEqual([event["type"] for event in events], ["piccolo_worker_ready", "piccolo_worker_closed"])


if __name__ == "__main__":
    unittest.main()
