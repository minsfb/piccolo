import json
import os
import pathlib
import subprocess
import sys
import signal
import time
import tempfile
import unittest


HOST = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "durable-host.py"


class DurableHostTest(unittest.TestCase):
    def assert_descendant_stopped(self, pid):
        deadline = time.monotonic() + 2
        while True:
            status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=2)
            # A zombie has stopped executing and cannot receive signals; its
            # new parent owns reaping. Both macOS and Linux expose this state.
            if status.returncode != 0 or status.stdout.lstrip().startswith("Z"):
                return
            if time.monotonic() >= deadline:
                self.fail(f"Owned descendant {pid} is still executing after wrapper exit")
            time.sleep(.02)

    def run_host(self, script, code=0, timeout=10):
        with tempfile.TemporaryDirectory(prefix="piccolo-host-") as directory:
            child = pathlib.Path(directory) / "fixture.py"
            child.write_text(script)
            result = subprocess.run(
                [sys.executable, str(HOST), "--", sys.executable, str(child)],
                capture_output=True, text=True, timeout=timeout,
            )
            self.assertEqual(result.returncode, code, result.stderr)
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
''', code=1)
        self.assertEqual(events, [{"type": "piccolo_worker_error", "error": "fixture startup failure"}])

    # #38 B-04: a startup deadline is a failure even if EOF makes the child exit 0.
    def test_startup_timeout_is_not_reported_as_success(self):
        events = self.run_host('import sys\nassert sys.stdin.read() == ""\n', code=1, timeout=40)
        self.assertEqual(events[0]["type"], "piccolo_worker_error")

    # #38 B-04: inherited pipes cannot leave the supervisor stuck after leader exit.
    def test_descendant_pipe_holders_are_terminated_after_leader_exit(self):
        with tempfile.TemporaryDirectory(prefix="piccolo-host-descendant-") as directory:
            root = pathlib.Path(directory)
            child = root / "fixture.py"
            group = root / "group.json"
            child.write_text('''import json,os,pathlib,subprocess,sys
descendant=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(60)'],stdout=subprocess.PIPE,text=True)
if descendant.stdout.readline().strip() != "ready": raise RuntimeError("Missing descendant TERM-ignore proof")
pathlib.Path(sys.argv[1]).write_text(json.dumps({'group':os.getpid(),'descendant':descendant.pid}))
print(json.dumps({'type':'piccolo_worker_ready'}),flush=True)
''')
            started = time.monotonic()
            try:
                result = subprocess.run([sys.executable, str(HOST), "--", sys.executable, str(child), str(group)], capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertLess(time.monotonic() - started, 9)
                self.assert_descendant_stopped(json.loads(group.read_text())["descendant"])
            finally:
                if group.exists():
                    try: os.killpg(json.loads(group.read_text())["group"], signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_managed_extension_events_on_stderr(self):
        events = self.run_host('''import json, sys
print("managed launcher diagnostic", file=sys.stderr, flush=True)
print(json.dumps({"type": "piccolo_worker_ready"}), file=sys.stderr, flush=True)
print(json.dumps({"type": "piccolo_worker_closed"}), file=sys.stderr, flush=True)
assert sys.stdin.read() == ""
''')
        self.assertEqual([event["type"] for event in events], ["piccolo_worker_ready", "piccolo_worker_closed"])

    def test_redirected_or_closed_descendant_streams_do_not_cancel_group_cleanup(self):
        for redirected in (True, False):
            with self.subTest(redirected=redirected), tempfile.TemporaryDirectory(prefix="piccolo-host-eof-") as directory:
                root = pathlib.Path(directory)
                group, ready, term = root / "group.json", root / "ready", root / "term"
                descendant = root / "descendant.py"
                descendant.write_text("""import os,pathlib,signal,sys,time
def on_term(*_):
    pathlib.Path(sys.argv[2]).write_text('TERM observed')
    for fd in (1,2):
        try: os.close(fd)
        except OSError: pass
signal.signal(signal.SIGTERM,on_term)
pathlib.Path(sys.argv[1]).write_text('ready')
time.sleep(60)
""")
                child = root / "fixture.py"
                child.write_text("""import json,os,pathlib,subprocess,sys,time
streams = {'stdout':subprocess.DEVNULL,'stderr':subprocess.DEVNULL} if sys.argv[5]=='True' else {}
p=subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2],sys.argv[3]],**streams)
deadline=time.monotonic()+3
while not pathlib.Path(sys.argv[2]).exists():
    if time.monotonic()>deadline: raise RuntimeError('No ready handshake')
    time.sleep(.01)
pathlib.Path(sys.argv[4]).write_text(json.dumps({'group':os.getpid(),'descendant':p.pid}))
print(json.dumps({'type':'piccolo_worker_ready'}),flush=True)
print(json.dumps({'type':'piccolo_worker_closed'}),flush=True)
""")
                try:
                    result = subprocess.run([sys.executable, str(HOST), "--", sys.executable, str(child), str(descendant), str(ready), str(term), str(group), str(redirected)], capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(term.read_text(), "TERM observed")
                    self.assert_descendant_stopped(json.loads(group.read_text())["descendant"])
                finally:
                    if group.exists():
                        try: os.killpg(json.loads(group.read_text())["group"], signal.SIGKILL)
                        except ProcessLookupError: pass


if __name__ == "__main__":
    unittest.main()
