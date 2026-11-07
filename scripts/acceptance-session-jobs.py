#!/usr/bin/env python3
"""Owned, normal-terminal acceptance for session-owned SDK jobs.

This runs the ordinary Pi executable; it does not change or bypass its sandbox.
Raw sessions and receipts stay in the explicitly selected fixture directory.
"""
import argparse
import io
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tarfile
import time


def checked(argv, cwd, env=None):
    return subprocess.check_output(argv, cwd=cwd, env=env, stderr=subprocess.STDOUT, text=True)


def require(condition, message="Acceptance condition failed; inspect the retained evidence"):
    if not condition:
        raise RuntimeError(message)


def prepare(args):
    source = Path(args.source).resolve()
    subagents = Path(args.subagents).resolve()
    models = Path(args.models_extension).resolve()
    package = json.loads((subagents / "package.json").read_text())
    if package.get("name") != "pi-subagents" or package.get("version") != "0.79.2":
        raise RuntimeError("Qualification requires the installed, compatible pi-subagents 0.79.2 package")
    if not models.is_file() or not (source / "node_modules").is_dir():
        raise RuntimeError("Source dependencies and the model extension must already be installed")
    if checked(["git", "status", "--porcelain"], source).strip():
        raise RuntimeError("Prepare from a clean committed Piccolo checkout")
    head = checked(["git", "rev-parse", "HEAD"], source).strip()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=False)
    archive = subprocess.check_output(["git", "archive", "--format=tar", head], cwd=source)
    snapshot = root / "source"
    snapshot.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(snapshot, filter="data")
    (snapshot / "node_modules").symlink_to((source / "node_modules").resolve(), target_is_directory=True)
    project = root / "project"
    for directory in [project / ".cache", project / ".pi", project / ".piccolo", root / "agent", root / "config", root / "state"]:
        directory.mkdir(parents=True)
    (root / "agent/settings.json").write_text("{}\n")
    (project / ".gitignore").write_text(".cache/\n.pi/\n")
    (project / "AGENTS.md").write_text("Owned session-worker qualification fixture. Follow the bounded test task exactly. Do not install packages, change configuration, publish, or work outside this fixture.\n")
    (project / ".pi/settings.json").write_text(json.dumps({"packages": [str(snapshot), str(subagents)], "extensions": [str(models)]}, indent=2) + "\n")
    config = f'''[integration]
child_extensions = [{json.dumps(str(models))}]
[pool]
capacity = 1
queue_timeout_ms = 180000
[background]
executor = "native"
notifications = {json.dumps(args.notifications)}
[agents.probe]
model = {json.dumps(args.gpt_model)}
effort = "medium"
tools = ["read", "bash"]
timeout_ms = 180000
prompt = "Perform requested bash commands with the actual bash tool and await their result. Never fabricate execution. Return a concise result."
[agents.queued]
model = {json.dumps(args.claude_model)}
effort = "medium"
context = "fork"
tools = ["read"]
timeout_ms = 180000
prompt = "Include ORIGINAL-PROMPT in your final answer and report the codeword from the captured parent conversation. Do not use bash."
'''
    (project / ".piccolo/config.toml").write_text(config)
    manifest = {"format": 1, "source_commit": head, "gpt_model": args.gpt_model, "claude_model": args.claude_model, "pi": args.pi, "notifications": args.notifications}
    (root / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    env = environment(root)
    checked(["git", "init", "-b", "main"], project)
    checked(["node", str(snapshot / "bin/piccolo.mjs"), "configure", "--cwd", str(project)], project, env)
    checked(["git", "add", "."], project)
    checked(["git", "-c", "user.name=Piccolo Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-m", "Prepare session-owned worker acceptance"], project)
    print(json.dumps({"status": "prepared", "root": str(root), "source_commit": head}))


def environment(root):
    return dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), XDG_CONFIG_HOME=str(root / "config"), XDG_STATE_HOME=str(root / "state"), PI_SUBAGENTS_TEMP_ROOT=str(root / "project/.cache/native-subagents"))


def command(root, manifest, name, rpc=False):
    argv = [manifest["pi"]]
    argv += ["--approve", "--session", str(root / "project/.cache" / name)]
    if rpc:
        argv += ["--mode", "rpc", "--model", manifest["gpt_model"], "--thinking", "medium"]
    return argv


class Rpc:
    def __init__(self, root, manifest):
        self.events = []
        self.buffer = b""
        self.log = (root / "project/.cache/jobs-rpc.stdout.jsonl").open("xb")
        self.err = (root / "project/.cache/jobs-rpc.stderr.log").open("x")
        self.process = subprocess.Popen(command(root, manifest, "jobs-rpc.jsonl", rpc=True), cwd=root / "project", env=environment(root), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def send(self, value):
        self.process.stdin.write(json.dumps(value).encode() + b"\n")
        self.process.stdin.flush()

    def pump(self, timeout=0.25):
        if not self.selector.select(timeout):
            return
        data = os.read(self.process.stdout.fileno(), 65536)
        self.log.write(data)
        self.log.flush()
        self.buffer += data
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            try:
                self.events.append(json.loads(line))
            except ValueError:
                pass

    def wait(self, predicate, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            if self.process.poll() is not None:
                raise RuntimeError(f"Managed Pi exited {self.process.returncode}; inspect retained stderr")
            self.pump()
        raise TimeoutError("Bounded qualification wait expired; evidence remains retained")

    def request(self, kind, **arguments):
        identity = str(time.monotonic_ns())
        start = len(self.events)
        self.send({"type": kind, "id": identity, **arguments})
        self.wait(lambda: any(event.get("type") == "response" and event.get("id") == identity for event in self.events[start:]))
        response = next(event for event in self.events[start:] if event.get("type") == "response" and event.get("id") == identity)
        if not response.get("success"):
            raise RuntimeError(str(response))
        return response.get("data", {})

    def prompt(self, text):
        start = len(self.events)
        self.request("prompt", message=text)
        self.wait(lambda: any(event.get("type") == "agent_end" for event in self.events[start:]))

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=25)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.selector.close()
        self.log.close()
        self.err.close()


def run(args):
    root = Path(args.root).resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    home = root / "project/.piccolo/jobs"
    receipt = root / "project/.cache/jobs-acceptance.json"
    if receipt.exists() or (root / "project/.cache/jobs-rpc.jsonl").exists():
        raise RuntimeError("This fixture already ran; preserve it and prepare a new root for another attempt")
    checks = {}
    rpc = None
    final_job = None
    try:
        rpc = Rpc(root, manifest)

        def start(task, kind="probe"):
            before = set(home.iterdir()) if home.exists() else set()
            arguments = {"kind": "delegate", "arguments": {"type": kind, "task": task}}
            rpc.prompt("Invoke piccolo_submit exactly once with these arguments: " + json.dumps(arguments) + ". End your turn immediately after submission. Do not wait or use other tools.")
            created = set(home.iterdir()) - before
            if len(created) != 1:
                raise RuntimeError("Expected exactly one submitted job; inspect retained tool events")
            return created.pop()

        def events(job):
            return [json.loads(file.read_text()) for file in sorted(job.glob("[0-9]*.json"))]

        def tool_started(job):
            def ready():
                if any(event.get("kind") == "tool_start" for event in events(job)):
                    return True
                if (job / "outcome.json").exists():
                    raise RuntimeError("Worker ended without executing its requested tool")
                return False
            rpc.wait(ready, 60)

        def outcome(job):
            rpc.wait(lambda: (job / "outcome.json").exists(), 120)
            return json.loads((job / "outcome.json").read_text())

        sleeper = "Execute bash with command sleep 90 and timeout 100. Await it before replying WORKER-DONE."
        rpc.prompt("Remember the acceptance codeword ORCHID-LOCAL-17. Reply ACK without tools.")
        first = start(sleeper)
        tool_started(first)
        began = time.monotonic()
        rpc.prompt("Reply exactly PARENT-RESPONSIVE without tools.")
        require(not (first / "outcome.json").exists())
        checks["parent_responsive_seconds"] = round(time.monotonic() - began, 3)
        second = start("Report the original prompt marker and the codeword from the captured parent conversation.", "queued")
        require(not any(event.get("kind") == "attached" for event in events(second)))
        rpc.prompt(f"Call piccolo_jobs message id {second.name} with text: After the original task, include QUEUED-MESSAGE together with the original marker and codeword. End your own turn without waiting.")
        rpc.prompt(f"Call piccolo_jobs stop id {first.name}. End your turn without waiting.")
        require(outcome(first)["state"] == "cancelled")
        result = outcome(second)
        text = json.dumps(result)
        require(result["state"] == "completed")
        require(all(marker in text for marker in ["ORIGINAL-PROMPT", "ORCHID-LOCAL-17", "QUEUED-MESSAGE"]))
        require(result["result"]["model"] in [manifest["claude_model"], manifest["claude_model"] + ":medium"])
        require(any(event.get("kind") == "message_delivered" for event in events(second)))
        attached = next(event for event in events(second) if event.get("kind") == "attached")
        require("bash" not in attached["tools"])
        checks.update({"gpt_stop": "pass", "queued_claude_snapshot_and_message": "pass", "read_only_tools": "pass"})
        third = start(sleeper)
        tool_started(third)
        previous = rpc.request("get_state")["sessionId"]
        require(rpc.request("new_session")["cancelled"] is False)
        require(rpc.request("get_state")["sessionId"] != previous)
        require(outcome(third)["state"] == "cancelled")
        checks["new_session_cancels_worker"] = "pass"
        final_job = start(sleeper)
        tool_started(final_job)
    except (Exception, KeyboardInterrupt) as error:
        checks["error"] = str(error)
    finally:
        if rpc:
            rpc.close()
        if final_job:
            file = final_job / "outcome.json"
            if file.exists() and json.loads(file.read_text()).get("state") == "cancelled":
                checks["quit_cancels_worker"] = "pass"
            else:
                checks["error"] = "Quit lacks a cancellation receipt; reconcile retained worker state"
        leases = list((root / "state/piccolo/pool").glob("*/slot-*.json"))
        result = {"status": "fail" if "error" in checks or leases else "pass", "source_commit": manifest["source_commit"], "checks": checks, "remaining_leases": [str(file) for file in leases], "scope": "Native SDK responsiveness, queued Claude context/message, explicit stop, new-session and quit ownership. TUI, full workflows and Blackhole remain separate checks."}
        receipt.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("--root", required=True)
    setup.add_argument("--source", default=str(Path(__file__).resolve().parents[1]))
    setup.add_argument("--subagents", required=True)
    setup.add_argument("--models-extension", required=True)
    setup.add_argument("--notifications", choices=["notify_only", "follow_up"], default="notify_only")
    setup.add_argument("--gpt-model", required=True)
    setup.add_argument("--claude-model", required=True)
    setup.add_argument("--pi", default="pi")
    for name in ["run", "ui"]:
        commands.add_parser(name).add_argument("--root", required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args)
        return 0
    if args.action == "run":
        return run(args)
    root = Path(args.root).resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    return subprocess.call(command(root, manifest, "jobs-ui.jsonl"), cwd=root / "project", env=environment(root))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Qualification stopped: {error}", file=sys.stderr)
        sys.exit(1)
