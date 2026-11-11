#!/usr/bin/env python3
"""Run bounded real-model pipeline cases in an explicitly owned OD fixture.

The managed Pi command supplies authentication/sandboxing. Dependencies and a
compatible runtime must already exist. This script creates a new synthetic Git
repository, starts only its worker, and closes owned processes in finally.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import time
import uuid


def uid():
    return str(uuid.uuid4())


def emit(check, **values):
    print(json.dumps({"check": check, **values}), flush=True)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, location, timeout=35):
        super().__init__("localhost", timeout=timeout)
        self.location = str(location)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.location)


def request(location, value):
    conn = UnixHTTP(location)
    try:
        conn.request("POST", "/v1", json.dumps(value), {"Content-Type": "application/json"})
        response = conn.getresponse()
        body = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(f"Fixture operation rejected: {str(body.get('error', 'unknown'))[:800]}")
        return body["result"]
    finally:
        conn.close()


def prepare_fixture(root):
    root.mkdir(mode=0o700)
    root = root.resolve(strict=True)
    worktrees = root / ".cache" / "worktrees"
    worktrees.mkdir(parents=True)
    state = root / ".cache" / "worker"
    state.mkdir(mode=0o700)
    control = root / ".cache" / "qualification"
    control.mkdir(mode=0o700)
    (root / ".gitignore").write_text("/.cache/\n/.pi/\n/.worktrees/\n")
    (root / "AGENTS.md").write_text("Work only in this candidate worktree. Follow the original task. Do not push, merge, access credentials or use network services. Commit intended implementation changes; review/QA stages must not change files. The harness runs configured checks.\n")
    (root / "app.mjs").write_text("export const baseline = 1;\n")
    (root / "crash-canary.txt").write_text("pipeline-safe-restart\n")

    def git(*argv, cwd=root):
        return subprocess.check_output(["git", "-C", str(cwd), *argv], text=True, stderr=subprocess.PIPE).strip()

    git("init")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("add", ".")
    git("commit", "-m", "fixture base")
    base = git("rev-parse", "HEAD")
    return root, worktrees, state, control, base


def main():
    if not __debug__:
        raise RuntimeError("Optimized Python is unsupported: qualification and owned-process guards must remain active")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--scenario", choices=["all", "restart"], default="all")
    parser.add_argument("--policy", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Supply the normal managed Pi command after --")
    source = args.source.resolve(strict=True)
    root = args.root.absolute()
    if root.exists():
        parser.error("Choose a new fixture root; existing work is never replaced")
    root, worktrees, state, control, base = prepare_fixture(root)

    def git(*argv, cwd=root):
        return subprocess.check_output(["git", "-C", str(cwd), *argv], text=True, stderr=subprocess.PIPE).strip()

    workspace = {"host": socket.gethostname(), "cwd": str(root), "identity": uid()}
    owner = "owned-pipeline-qualification"
    config = {"directory": str(state), "workspace": workspace, "pool": {"capacity": 1, "queue_timeout_ms": 1000, "max_launches_per_session": 64}}
    if args.policy:
        config["policy"] = json.loads(args.policy.resolve(strict=True).read_text())
    (state / "config.json").write_text(json.dumps(config))
    processes = []
    log_files = []

    def start():
        env = dict(os.environ)
        env.update(PICCOLO_WORKER_CONFIG=str(state / "config.json"), PICCOLO_PIPELINE_FIXTURE_ROOT=str(root), XDG_STATE_HOME=str(root / ".cache" / "state"))
        log = open(control / f"host-{len(processes)}.log", "w")
        log_files.append(log)
        argv = ["python3", str(source / "scripts" / "durable-host.py"), "--", *command, "--mode", "rpc", "-e", str(source / "tests" / "fixtures" / "durable-pipeline-control.ts")]
        process = subprocess.Popen(argv, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Owned worker exited during startup; inspect the private fixture log")
            try:
                info = request(state / "worker.sock", {"operation": "info", "workspace": workspace})
                proof = request(control / "control.sock", {"operation": "probe"})
                require(proof.get("pid") == info["pid"], "Owned fault hook did not identify the current runtime")
                emit("worker_ready", pid=info["pid"], runtime=info["runtime"], capacity=info["capabilities"]["capacity"])
                return process, info
            except (OSError, http.client.HTTPException):
                time.sleep(.2)
        raise TimeoutError("Owned worker startup did not finish")

    def call(operation, **values):
        return request(state / "worker.sock", {"operation": operation, "workspace": workspace, **values})

    def stage(name, tools):
        return {"name": name, "task": "Perform your stage for the original task; identify concrete candidate evidence.", "model": {"provider": "anthropic", "modelId": args.model},
                "instructions": "Act only in the assigned candidate worktree and role. Preserve the exact candidate during review and QA. Do not duplicate the harness validation commands. Return the requested JSON report.",
                "tools": tools, "thinkingLevel": "off", "report": True, "timeoutMs": 600000}

    def workflow(name, task, assertions, candidate=None, cwd=None, branch=None):
        check = "import assert from 'node:assert/strict'; const m = await import('./app.mjs'); " + assertions
        result = {"root": str(root), "worktree": str(cwd or worktrees / name), "branch": branch or "qualify-" + name, "base": base, "task": task, "maxRevisions": 0,
                  "stages": {"implement": [stage("implement", ["read", "write", "edit", "bash"])], "review": [stage("review-one", ["read", "bash"]), stage("review-two", ["read", "bash"])], "qa": [stage("qa", ["read", "bash"])]},
                  "checks": {"behavior": {"command": shlex.quote(args.node) + " --input-type=module -e " + shlex.quote(check), "cwd": ".", "boundary": "isolated", "scope": "Owned arithmetic fixture", "timeout_ms": 10000, "required": True}}, "validationMode": "required"}
        if candidate:
            result["candidate"] = candidate
        return result

    def submit(nodes, kind="experiment"):
        payload = {"version": 1, "registry": "piccolo-1", "requestId": uid(), "workspace": workspace, "owner": owner, "lifetime": "independent", "configDigest": "0" * 64, "kind": kind,
                   "pipeline": {"nodes": nodes, "maxActive": 2, "failFast": True, "source": {"root": str(root), "base": base, "files": {}}, "timeoutMs": 1200000}}
        admission = call("submit", submission=payload)
        require(call("submit", submission=payload)["taskId"] == admission["taskId"], "Duplicate submission changed its task identity")
        return payload["requestId"], admission["taskId"]

    queue_seen = False
    cases = []

    def record_case(check, evidence, **values):
        cases.append({"case": check, "evidence": evidence, **values})
        emit(check, evidence=evidence, **values)

    def wait(request_id, timeout=900):
        nonlocal queue_seen
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = call("inspect", requestId=request_id)
            queue_seen |= any(child.get("phase") == "waiting" for child in value.get("children", []))
            if value["task"]["state"]["status"] == "terminal":
                return value["task"]["state"]["outcome"]
            if value.get("attention"):
                raise RuntimeError("Qualification stage needs an unexpected parent decision; inspect fixture status")
            time.sleep(.5)
        raise TimeoutError("Owned staged pipeline did not settle")

    def assert_success(outcome):
        require(outcome["status"] == "completed" and outcome["result"]["status"] == "complete", "Pipeline did not complete; inspect its retained fixture outcome")
        for node in outcome["result"]["results"].values():
            require(node["status"] == "complete" and node["correctness"] == "pass", "A pipeline node lacks successful required validation")
            require(all(item and item["observed"] == ["anthropic/" + args.model] for item in node["result"]["provenance"]), "Observed stage model differs from the requested fixture model")
        require(git("rev-parse", "HEAD") == base, "Qualification source HEAD changed")
        require(not git("diff", "HEAD", "--", ":(exclude).piccolo"), "Qualification modified tracked source inputs")
        require(all(name.startswith(".piccolo/") for name in git("ls-files", "--others", "--exclude-standard").splitlines()), "Qualification left untracked source inputs")

    try:
        process, info = start()
        if args.scenario == "all":
            happy = workflow("happy", "Add exported function double(x) returning 2*x. Keep baseline and the crash canary unchanged.", "for (const x of [-4,0,3,13]) assert.equal(m.double(x), 2*x);")
            job, _ = submit({"happy": {"needs": [], "criterion": {"kind": "required_checks"}, "work": {"kind": "workflow", "workflow": happy}}})
            outcome = wait(job)
            assert_success(outcome)
            require(queue_seen, "Parallel review did not expose a durable capacity waiter")
            happy_result = outcome["result"]["results"]["happy"]["result"]
            record_case("managed_staged_workflow", "required_command_pass", candidate=happy_result["candidate"], stages=len(happy_result["provenance"]), checks=len(happy_result["checks"]))
            failure = workflow("failure", "Inspect the existing candidate; the harness intentionally fails its required check.", "assert.fail('Deliberate fixture validation failure');", candidate=happy_result["candidate"], cwd=happy_result["worktree"], branch=happy_result["branch"])
            job, _ = submit({"failure": {"needs": [], "criterion": {"kind": "required_checks"}, "work": {"kind": "workflow", "workflow": failure}}})
            failed = wait(job)["result"]
            require(failed["status"] == "needs_parent" and failed["results"]["failure"]["correctness"] == "fail", "Configured failure was not graded as a failed pipeline result")
            check_ids = failed["results"]["failure"]["result"]["checks"]
            if check_ids:
                evidence = Path(happy_result["worktree"]) / ".cache" / "piccolo" / "checks" / check_ids[0] / "receipt.json"
                receipt = json.loads(evidence.read_text())
                require(receipt["status"] == "fail" and receipt["exit_code"] not in (None, 0), "Required command lacks a real nonzero failure receipt")
                require(receipt["candidate"] == happy_result["candidate"], "Failure receipt identifies another candidate")
                record_case("managed_required_check_failure", "required_command_nonzero_exit", status=failed["status"], checks=len(check_ids), exit=receipt["exit_code"])
            else:
                record_case("managed_review_rejected_configured_failure", "review_rejection_without_command_execution", status=failed["status"], checks=0, note="Review rejected before command execution; this is not a harness-failure receipt")
            nodes = {}
            for name, needs, task, check in [
                ("left", [], "Create left.mjs exporting twice(x) returning 2*x. Do not modify app.mjs or any other existing file.", "const l = await import('./left.mjs'); assert.equal(l.twice(7), 14);"),
                ("right", [], "Create right.mjs exporting plusOne(x) returning x+1. Do not modify app.mjs or any other existing file.", "const r = await import('./right.mjs'); assert.equal(r.plusOne(7), 8);"),
                ("join", ["left", "right"], "The harness integrated both exact predecessors. Add exported composed(x) in joined.mjs returning twice(plusOne(x)), and re-export it from app.mjs. Preserve both predecessors.", "for (const x of [-4,0,3,13]) assert.equal(m.composed(x), 2*(x+1));")]:
                nodes[name] = {"needs": needs, "criterion": {"kind": "required_checks"}, "work": {"kind": "workflow", "workflow": workflow(name, task, check)}}
            job, _ = submit(nodes, "schedule")
            joined = wait(job)
            assert_success(joined)
            results = joined["result"]["results"]
            for name in ["left", "right"]:
                git("merge-base", "--is-ancestor", results[name]["result"]["candidate"], results["join"]["result"]["candidate"])
            record_case("managed_exact_dependency_join", "required_command_pass_and_exact_ancestry", nodes=3, candidate=results["join"]["result"]["candidate"])
        (control / "enable-crash-read").write_text("owned safe-read gate\n")
        restart = workflow("restart", "Your FIRST tool must be read of crash-canary.txt. After that, add exported recovered(x) returning x+2 to app.mjs. Do not edit baseline or the canary.", "assert.equal(m.recovered(7), 9); const fs = await import('node:fs'); assert.equal(fs.readFileSync('./crash-canary.txt','utf8'), 'pipeline-safe-restart\\n');")
        expected_canary = str(Path(restart["worktree"]) / "crash-canary.txt")
        (control / "expected-read.json").write_text(json.dumps({"cwd": restart["worktree"], "path": expected_canary}))
        job, task_id = submit({"restart": {"needs": [], "criterion": {"kind": "required_checks"}, "work": {"kind": "workflow", "workflow": restart}}})
        deadline = time.monotonic() + 180
        while not (control / "paused-read.json").exists():
            require(not (control / "read-gate-violation.json").exists(), "Restart stage violated its first-tool/canary identity guard; no runtime was killed")
            if time.monotonic() >= deadline:
                raise TimeoutError("Managed implementer did not reach its mandatory safe-read gate")
            time.sleep(.2)
        marker = json.loads((control / "paused-read.json").read_text())
        require(marker["pid"] == call("info")["pid"], "Paused-read marker identifies another runtime PID")
        require(Path(f"/proc/{marker['pid']}/cwd").resolve() == root, "Paused runtime is outside the owned qualification root")
        require(marker.get("firstTool") == "read" and marker.get("canaryPath") == expected_canary and marker.get("stageCwd") == restart["worktree"], "Paused read is not the exact first candidate canary read")
        require(not (control / "read-gate-violation.json").exists(), "Restart tool order was violated before the crash gate")
        os.kill(marker["pid"], signal.SIGKILL)
        process.wait(timeout=45)
        process, info = start()
        require(call("inspect", requestId=job)["taskId"] == task_id, "Restart resumed a different task identity")
        recovered = wait(job)
        assert_success(recovered)
        candidate = recovered["result"]["results"]["restart"]["result"]
        require(candidate["worktree"] == restart["worktree"] and candidate["branch"] == restart["branch"], "Restart returned a different candidate worktree")
        require((Path(candidate["worktree"]) / "crash-canary.txt").read_text() == "pipeline-safe-restart\n", "Returned candidate changed its canary")
        require(git("show", candidate["candidate"] + ":crash-canary.txt") == "pipeline-safe-restart", "Returned commit changed its canary")
        require((root / "crash-canary.txt").read_text() == "pipeline-safe-restart\n", "Qualification source canary changed")
        record_case("managed_pipeline_runtime_death_and_resume", "owned_pre_effect_crash_and_same_task_recovery", taskId=task_id, candidate=recovered["result"]["results"]["restart"]["result"]["candidate"])
        emit("qualification_finished", scenarios=len(cases), cases=cases, library="pi-durable/1.3.0")
    finally:
        try:
            if processes and processes[-1].poll() is None:
                call("close", mode="suspend", owner=owner)
        except (OSError, RuntimeError, http.client.HTTPException):
            pass
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=40)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
        for log in log_files:
            log.close()


if __name__ == "__main__":
    main()
