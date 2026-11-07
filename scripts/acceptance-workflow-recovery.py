#!/usr/bin/env python3
"""Live isolated workflow test: failed preflight -> health wake -> bounded retry.
Requires a fresh acceptance-session-jobs.py prepared fixture; uses real models.
No operator status prompts, package installs, real services, push or merge.
"""
import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("jobs", Path(__file__).with_name("acceptance-session-jobs.py"))
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--validation-case", choices=["pass", "fail"])
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    project = root / "project"
    if (project / ".cache/jobs-rpc.jsonl").exists() or (root / "workflow-acceptance.json").exists():
        raise RuntimeError("Preserve existing evidence; prepare a fresh fixture")
    settings = json.loads((project / ".pi/settings.json").read_text())
    settings["packages"].append(str(root / "source/packages/health"))
    probe = root / "exit-probe.ts"
    probe.write_text('import fs from "node:fs"; export default function(pi){ pi.registerCommand("acceptance-exit",{description:"End owned fixture",handler:async(a,c)=>c.shutdown()}); pi.on("session_shutdown",()=>fs.writeFileSync(".cache/shutdown.json","{}")); }')
    settings["extensions"].append(str(probe))
    (project / ".pi/settings.json").write_text(json.dumps(settings) + "\n")
    with (project / ".piccolo/config.toml").open("a") as stream:
        stream.write('\n[agents.implementer]\nmodel=' + json.dumps(manifest["gpt_model"]) + '\neffort="medium"\n[agents.reviewer]\nmodel=' + json.dumps(manifest["claude_model"]) + '\neffort="medium"\n[agents.qa]\nmodel=' + json.dumps(manifest["gpt_model"]) + '\neffort="medium"\n')
    if args.validation_case:
        command = "python3 -B -m unittest discover -s tests -p test_clean_lines.py" if args.validation_case == "pass" else "printf EXPECTED-CHECK-FAILURE; exit 3"
        with (project / ".piccolo/config.toml").open("a") as stream:
            stream.write('\n[jobs.implementation.validation.checks.acceptance]\ncommand=' + json.dumps(command) + '\ncwd="."\nboundary="isolated"\nscope="Owned acceptance fixtures only"\ntimeout_ms=30000\nrequired=true\n')
    (project / ".cache/worktrees").mkdir()
    (project / "clean_lines.py").write_text('def clean_lines(text):\n    raise NotImplementedError\n')
    (project / "tests").mkdir()
    with (project / ".gitignore").open("a") as stream:
        stream.write("__pycache__/\n")
    (project / "tests/test_clean_lines.py").write_text("import unittest\nfrom clean_lines import clean_lines\nclass Checks(unittest.TestCase):\n def test_content(self): self.assertEqual(clean_lines('a  \\n  b\\t'), 'a\\n  b')\n def test_empty(self): self.assertEqual(clean_lines(''), '')\n def test_final(self): self.assertEqual(clean_lines('x  \\n'), 'x\\n')\n")
    task = "Implement clean_lines(text) in clean_lines.py: remove trailing spaces and tabs from each line, preserving indentation, empty input, newline separators and final newline. Add or refine isolated unittest fixtures as needed. Run only python3 -m unittest discover -s tests -p test_clean_lines.py with a 30-second timeout; no services or installs. Commit intended code/tests. Do not push, merge, change branches, or run broad unrelated checks. Report required test result honestly."
    env = jobs.environment(root)
    subprocess.run(["node", str(root / "source/bin/piccolo.mjs"), "configure", "--cwd", str(project)], cwd=project, env=env, check=True, capture_output=True)
    subprocess.run(["git", "add", ".piccolo/config.toml", ".gitignore", "clean_lines.py", "tests"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-m", "Prepare isolated workflow task"], cwd=project, check=True, capture_output=True)
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip()
    invalid = str(project / ".cache/missing-parent/worker")
    valid = str(project / ".cache/worktrees/worker")
    arguments = {"task": task, "branch": "acceptance/clean-lines", "worktree": invalid, "max_revisions": 1, "job": "implementation", "base": base, "overrides_toml": ""}
    prompt = ('If health wakes you about an unrelated prior rejected tool call while the actual job is still running, inspect and record that incident honestly, then end your turn and allow the job to continue. A health incident alone is not proof of job failure. Never terminate acceptance with a final marker while a job is queued or running. Acceptance exercise. Submit one session-owned workflow using piccolo_submit kind workflow and arguments ' + json.dumps(arguments) + '. Return immediately with its job ID, do not poll/wait. The first launch should be blocked by its missing worktree parent. When health wakes you, inspect the exact incident and piccolo_jobs result. Verify with bash that branch acceptance/clean-lines was not created. Submit exactly one retry using the SAME task, branch and max_revisions with worktree ' + valid + '. After submitting the retry, acknowledge the first job with piccolo_jobs ack using its inspected outcome_revision, a decision note explaining the corrected path, and replacement equal to the retry job ID. Resolve the first health incident after that. Return immediately with the new job ID. When health wakes you for the retry, inspect its result and workflow stage records. Require implementation, independent review, QA, a clean descendant candidate and passing focused tests. Resolve the new incident after verifying completion and reply exactly WORKFLOW-RECOVERY-PASS followed by the candidate SHA. If anything else fails, record an honest development disposition and reply WORKFLOW-RECOVERY-BLOCKED; do not submit a third workflow. Do not push/merge/install, clean worktrees, change config or run unrelated project tasks.')
    if args.validation_case == "fail":
        prompt += " The final harness check is deliberately configured to exit 3. Expected second workflow outcome is partial with validation incomplete, while worker implementation/review/QA reports complete. Inspect the retained configured-check receipt and EXPECTED-CHECK-FAILURE output. Do not fix or repeat this deliberate failure. Resolve the final attention incident after acknowledging that expected partial outcome and explaining it in the decision, then emit WORKFLOW-RECOVERY-PASS plus candidate. This marker means the negative acceptance succeeded, never that project validation passed."
    rpc = None
    checks = {}
    started = time.monotonic()
    try:
        rpc = jobs.Rpc(root, manifest)
        rpc.prompt(prompt)
        final = lambda: next((e for e in reversed(rpc.events) if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant" and e["message"].get("stopReason") == "stop" and any(p.get("type") == "text" and p.get("text", "").startswith("WORKFLOW-RECOVERY-") for p in e["message"].get("content", []) if isinstance(p, dict))), None)
        rpc.wait(lambda: final() is not None, 900)
        end_index = rpc.events.index(final())
        rpc.wait(lambda: any(e.get("type") == "agent_settled" for e in rpc.events[end_index + 1:]), 30)
        outcomes = [json.loads(p.read_text()) for p in (project / ".piccolo/jobs").glob("*/outcome.json")]
        expected_status = "partial" if args.validation_case == "fail" else "complete"
        successful = [o for o in outcomes if o.get("result", {}).get("status") == expected_status]
        launches = list((project / ".piccolo/jobs").glob("*/launch.json"))
        checks["two_attempts"] = len(launches) == len(outcomes) == 2
        checks["no_unfinished_before_teardown"] = all(p.with_name("outcome.json").exists() for p in launches)
        decisions = [json.loads(p.read_text()) for p in (project / ".piccolo/jobs").glob("*/[0-9]*.json") if json.loads(p.read_text()).get("kind") == "parent_decision"]
        checks["parent_acknowledged"] = len(decisions) == 2 and {d["job"] for d in decisions} == {o["id"] for o in outcomes}
        checks["explicit_supersession"] = sum(d.get("disposition") == "superseded" and d.get("replacement") in {o["id"] for o in successful} for d in decisions) == 1
        checks["blocked_preflight"] = sum("parent must already exist" in o.get("result", {}).get("summary", "") for o in outcomes) == 1
        checks["workflow_outcome_expected"] = len(successful) == 1
        if successful:
            result = successful[0]["result"]
            records = [json.loads(p.read_text()) for p in Path(result["record"]).glob("[0-9]*.json")]
            checks["all_stages"] = all(any(r.get("stage") == stage and r.get("report", {}).get("status") == "complete" for r in records) for stage in ["implement", "review", "qa"])
            if args.validation_case:
                validation = result.get("validation", {})
                expected = "incomplete" if args.validation_case == "fail" else "complete"
                checks["validation_classification"] = validation.get("status") == expected
                attempts = validation.get("checks", [])
                checks["one_harness_check"] = len(attempts) == 1
                if len(attempts) == 1:
                    receipt = json.loads((Path(valid) / ".cache/piccolo/checks" / attempts[0]["id"] / "receipt.json").read_text())
                    checks["check_receipt"] = receipt["candidate"] == result["candidate"] and receipt["status"] == ("fail" if args.validation_case == "fail" else "pass") and receipt["exit_code"] == (3 if args.validation_case == "fail" else 0)
            candidate = result["candidate"]
            checks["new_candidate"] = candidate != base
            checks["clean_worktree"] = not subprocess.check_output(["git", "status", "--porcelain"], cwd=valid, text=True).strip()
            checks["parent_base_unchanged"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip() == base
            checks["focused_tests"] = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_clean_lines.py"], cwd=valid, env=dict(env, PYTHONDONTWRITEBYTECODE="1"), timeout=30, capture_output=True).returncode == 0
        runs = [json.loads(p.read_text()) for p in (project / ".piccolo/runs").glob("*/outcome.json")]
        models = [r.get("native", {}).get("model", "") for r in runs]
        checks["both_model_families"] = all(any(m == expected or m.startswith(expected + ":") for m in models) for expected in [manifest["gpt_model"], manifest["claude_model"]])
        entries = [json.loads(line) for line in (project / ".cache/jobs-rpc.jsonl").read_text().splitlines()]
        checks["automatic_wakes"] = sum(e.get("customType") == "harness-health-parent-start" for e in entries) >= 2
        incidents = [i for p in (root / "state/pi-harness-health").glob("*/*.json") for i in json.loads(p.read_text()).get("incidents", []) if i["component"] == "attention"]
        checks["resolved_attention"] = len(incidents) == 2 and all(i["disposition"] == "resolved" for i in incidents)
        checks["parent_final"] = any(p.get("text", "").startswith("WORKFLOW-RECOVERY-PASS") for p in final()["message"]["content"] if isinstance(p, dict))
    except (Exception, KeyboardInterrupt) as error:
        checks["runner_error"] = type(error).__name__
    finally:
        if rpc:
            if rpc.process.poll() is None:
                # Failed qualification can leave active owned work. Use native
                # confirmed session replacement to await its cancellation before
                # closing RPC; this is teardown, never acceptance recovery.
                unfinished = [p for p in (project / ".piccolo/jobs").glob("*/launch.json") if not p.with_name("outcome.json").exists()]
                if unfinished:
                    checks["no_unfinished_before_teardown"] = False
                    try: checks["failure_teardown"] = rpc.request("new_session").get("cancelled") is False
                    except Exception: checks["failure_teardown"] = False
                rpc.send({"type": "prompt", "message": "/acceptance-exit"})
            rpc.close()
            checks["native_shutdown"] = rpc.process.returncode == 0 and (project / ".cache/shutdown.json").exists()
    checks["no_remaining_leases"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
    result = {"status": "pass" if checks and all(v is True for v in checks.values()) else "fail", "checks": checks, "source_commit": manifest["source_commit"], "validation_case": args.validation_case, "elapsed_seconds": round(time.monotonic() - started, 3), "scope": "One failed worktree preflight, automatic parent retry, GPT implementation/QA and Claude review, explicit supersession and health-linked result acknowledgment, no user status prompts; not the full hardening matrix."}
    (root / "workflow-acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1

if __name__ == "__main__":
    sys.exit(main())
