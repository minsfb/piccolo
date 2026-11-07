#!/usr/bin/env python3
"""Qualify review/QA continuation and required checks for an existing candidate.

Uses an existing, fresh acceptance-session-jobs.py prepared fixture. Adds health
only to this owned fixture before Pi starts. Sends one user task, no status nudges.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location("jobs_acceptance", Path(__file__).with_name("acceptance-session-jobs.py"))
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


def parent_final_after_disposition(events):
    """Locate a final answer after actual handling, including a refused probe."""
    disposition = max((index for index, event in enumerate(events)
                       if event.get("type") == "tool_execution_end" and event.get("toolName") == "harness_health"
                       and not event.get("isError")
                       and any(i.get("disposition") in {"resolved", "development"}
                               for i in event.get("result", {}).get("details", {}).get("incidents", []))), default=-1)
    final = max((index for index, event in enumerate(events)
                 if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"
                 and event["message"].get("stopReason") == "stop"), default=-1)
    return final if disposition >= 0 and final > disposition else -1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--nested-checks", action="store_true", help="Require nested-cwd checks, retaining an intentional failure and a later pass")
    parser.add_argument("--compatibility", choices=["managed-0.85.1", "managed-0.86.1", "managed-1.3.0"], default="managed-1.3.0")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    if manifest.get("notifications") != "follow_up":
        raise RuntimeError("Health wake acceptance requires a fresh fixture prepared with --notifications follow_up")
    receipt = root / "continuation-acceptance.json"
    if receipt.exists() or (root / "project/.cache/jobs-rpc.jsonl").exists():
        raise RuntimeError("Fixture already ran; preserve it and prepare a new one")
    project = root / "project"
    settings_path = project / ".pi/settings.json"
    settings = json.loads(settings_path.read_text())
    settings["packages"].append(str(root / "source/packages/health"))
    probe = root / "exit-probe.ts"
    probe.write_text('''import fs from "node:fs";
export default function probe(pi) {
 pi.registerCommand("health-acceptance-exit", {description:"End owned test",handler:async(_args,ctx)=>ctx.shutdown()});
 pi.on("session_shutdown",()=>fs.writeFileSync(".cache/health-shutdown.json","{}"));
}
''')
    settings["extensions"].append(str(probe))
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    (project / ".pi/health.toml").write_text('interval_ms = 1000\nattention_ms = 30000\ncompatibility = ' + json.dumps(args.compatibility) + '\n')
    (project / "README.md").write_text("This isolated project has codeword HEALTH-PROBE-29.\n")
    # Patch a private package copy only, before launching this fixture.
    import shutil
    native = next(Path(p) for p in settings["packages"] if (Path(p) / "package.json").is_file() and json.loads((Path(p) / "package.json").read_text()).get("name") == "pi-subagents")
    copied = root / "native-subagents"
    shutil.copytree(native, copied, symlinks=False)
    (root / "node_modules").symlink_to(native.parent, target_is_directory=True)
    jobs.checked(["python3", str(root / "source/scripts/subagents-supervisor-compat.py"), "--package-root", str(copied)], project)
    settings["packages"] = [str(copied) if p == str(native) else p for p in settings["packages"]]
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    base = jobs.checked(["git", "rev-parse", "HEAD"], project).strip()
    worktree = root / "candidate"
    branch = "acceptance/existing-candidate"
    jobs.checked(["git", "worktree", "add", "-b", branch, str(worktree), base], project)
    (worktree / "sum.mjs").write_text("export const sum = (a, b) => a + b;\n")
    (worktree / "check.mjs").write_text('import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; assert.equal(sum(2,3),5); assert.equal(sum(-2,2),0); console.log("CANDIDATE-CHECK-PASS");\n')
    if args.nested_checks:
        (worktree / ".gitignore").write_text("/.pi/\n/.cache/\n")
        (worktree / "agent").mkdir()
        (worktree / "agent/marker").write_text("NESTED-CWD")
        with (worktree / "check.mjs").open("a") as check:
            check.write('import fs from "node:fs"; assert.equal(fs.readFileSync("marker", "utf8"), "NESTED-CWD");\n')
        jobs.checked(["git", "add", ".gitignore", "agent/marker"], worktree)
    jobs.checked(["git", "add", "sum.mjs", "check.mjs"], worktree)
    jobs.checked(["git", "-c", "user.name=Piccolo Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-m", "Existing candidate"], worktree)
    head = jobs.checked(["git", "rev-parse", "HEAD"], worktree).strip()
    jobs.checked(["node", str(root / "source/bin/piccolo.mjs"), "configure", "--cwd", str(worktree)], worktree, jobs.environment(root))
    rpc = None
    checks = {}
    observed = {}
    started = time.monotonic()
    try:
        rpc = jobs.Rpc(root, manifest)
        arguments = {"kind": "workflow", "arguments": {"task": "Review and validate the existing sum.mjs candidate, which adds two numbers. Do not implement or commit anything unless independent review discovers a real defect. Do not publish or start services. The harness will run node check.mjs once after QA; QA should inspect that check and its isolation, not duplicate it.", "worktree": str(worktree), "branch": branch, "base": base, "candidate": head, "max_revisions": 0, "validation_checks": {"focused": {"command": "node check.mjs", "boundary": "isolated", "scope": "Pure local arithmetic assertions", "timeout_ms": 10000}}}}
        expectation = "validation is complete"
        if args.nested_checks:
            arguments["arguments"]["task"] = "Review this harness-test fixture, not a releasable application. Its specification requires correct sum.mjs arithmetic, reading agent/marker from the requested cwd, and one deliberate required-check exit 7 between two passing checks. Stage reports assess whether this fixture implements that specification: report complete if the fixture is correct, or challenge/report defects if it is not. A complete review/QA report does not certify that required checks passed. Do not preempt validation solely because its specified negative control must fail. The harness executes all three checks once AFTER QA; leave that execution to it. The overall workflow must then remain partial/unqualified, preserving exit 7. No implementation, commits, installs or services."
            arguments["arguments"]["validation_checks"] = {
                "focused": {"command": "node ../check.mjs", "cwd": "agent", "boundary": "isolated", "scope": "Pure local arithmetic and cwd marker assertions", "timeout_ms": 10000},
                "expected_failure": {"command": "exit 7", "cwd": "agent", "boundary": "isolated", "scope": "Intentional fixture failure, never waived", "timeout_ms": 10000},
                "after_failure": {"command": "node ../check.mjs", "cwd": "agent", "boundary": "isolated", "scope": "Later check must run without candidate pollution", "timeout_ms": 10000},
            }
            expectation = "all three check receipts exist, the intentional exit 7 remains a failure, the later check passed, and validation remains incomplete/unqualified"
        rpc.prompt("Call piccolo_submit exactly once with " + json.dumps(arguments) + ". Return immediately with the job ID; do not poll or wait. On harness health wake, inspect the incident and exact job result, verify the candidate has not changed and " + expectation + ", acknowledge its outcome revision, resolve the incident verified_recovery, and reply REAL-JOB-RECOVERED HEALTH-PROBE-29. Do not launch other work or modify any files.")

        home = project / ".piccolo/jobs"
        created = list(home.iterdir())
        jobs.require(len(created) == 1, "Expected exactly one submitted job")
        job = created[0]
        def attention(dispositions):
            snapshots = (root / "state/pi-harness-health").glob("*/*.json")
            return any(i["component"] == "attention" and i["disposition"] in dispositions
                       for p in snapshots for i in json.loads(p.read_text()).get("incidents", []))
        # A handled refusal is terminal evidence too. Do not turn it into a
        # misleading timeout by waiting exclusively for successful recovery.
        rpc.wait(lambda: attention({"resolved", "development"}), 240)
        rpc.wait(lambda: parent_final_after_disposition(rpc.events) >= 0, 60)
        final_index = parent_final_after_disposition(rpc.events)
        rpc.wait(lambda: any(event.get("type") == "agent_settled" for event in rpc.events[final_index + 1:]), 30)
        checks["parent_settled"] = True
        checks["no_leases_before_shutdown"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
        checks["all_launches_settled"] = all((p.parent / "outcome.json").is_file() for folder in ["jobs", "runs"] for p in (project / ".piccolo" / folder).glob("*/launch.json"))
        outcome = json.loads((job / "outcome.json").read_text())
        entries = [json.loads(line) for line in (project / ".cache/jobs-rpc.jsonl").read_text().splitlines()]
        tool_calls = [c for e in entries for c in e.get("message", {}).get("content", []) if isinstance(c, dict) and c.get("type") == "toolCall"]
        workflow = outcome.get("result", {})
        observed = {"job_state": outcome.get("state"), "workflow_status": workflow.get("status"), "summary": workflow.get("summary"), "validation": workflow.get("validation")}
        stages = [json.loads(p.read_text()) for p in Path(workflow["record"]).glob("[0-9]*.json")]
        checks.update({
            "one_submission": sum(c.get("name") == "piccolo_submit" for c in tool_calls) == 1,
            "job_terminal_expected": outcome["state"] == ("needs_parent" if args.nested_checks else "completed"),
            "workflow_outcome_expected": workflow["status"] == ("partial" if args.nested_checks else "complete"),
            "same_candidate": workflow["candidate"] == head == jobs.checked(["git", "rev-parse", "HEAD"], worktree).strip(),
            "no_implementation_replay": not any(e.get("stage") == "implement" for e in stages),
            "independent_review_and_qa": all(any(e.get("stage") == stage and e.get("report", {}).get("commit") == head for e in stages) for stage in ["review", "qa"]),
            "required_receipt": workflow["validation"]["status"] == ("incomplete" if args.nested_checks else "complete") and workflow["qualification"] == ("unqualified" if args.nested_checks else "checks_passed") and workflow["validation"]["required"] == list(arguments["arguments"]["validation_checks"]),
            "native_parent_wake": any(e.get("customType") == "harness-health-parent-start" for e in entries),
            "parent_consumed_result": any(c.get("name") == "piccolo_jobs" and c["arguments"].get("action") == "result" and c["arguments"].get("id") == job.name for c in tool_calls),
            "explicit_disposition": attention({"resolved"}),
            "parent_final": any(c.get("type") == "text" and c.get("text", "").strip() == "REAL-JOB-RECOVERED HEALTH-PROBE-29"
                                for c in rpc.events[final_index]["message"].get("content", []) if isinstance(c, dict)),
        })

        if args.nested_checks:
            receipts = [json.loads(p.read_text()) for p in (worktree / ".cache/piccolo/checks").glob("*/receipt.json")]
            by_name = {r["check"]: r for r in receipts}
            checks["each_check_once"] = len(receipts) == 3 and set(by_name) == {"focused", "expected_failure", "after_failure"}
            checks["retained_failure"] = by_name.get("expected_failure", {}).get("status") == "fail" and by_name.get("expected_failure", {}).get("exit_code") == 7
            checks["later_check_passed"] = by_name.get("focused", {}).get("status") == by_name.get("after_failure", {}).get("status") == "pass"
            checks["command_cwd_preserved"] = all(r["cwd"] == str(worktree / "agent") for r in receipts)
            checks["candidate_clean"] = not jobs.checked(["git", "status", "--porcelain"], worktree).strip()
            checks["root_shell_receipts"] = len(list((worktree / ".cache/piccolo/shell").glob("*/receipt.json"))) >= 3 and not (worktree / "agent/.cache").exists()

    except (Exception, KeyboardInterrupt) as error:
        checks["runner_error"] = type(error).__name__
    finally:
        if rpc:
            try:
                if rpc.process.poll() is None:
                    if not checks.get("parent_settled"):
                        rpc.send({"type": "abort"})
                        time.sleep(0.5)
                    rpc.send({"type": "prompt", "message": "/health-acceptance-exit"})
                    deadline = time.monotonic() + 25
                    while rpc.process.poll() is None and time.monotonic() < deadline:
                        rpc.pump()
                checks["no_forced_cleanup"] = rpc.process.poll() is not None
            except Exception as error:
                checks["cleanup_error"] = type(error).__name__
            finally:
                try:
                    rpc.close()
                except Exception as error:
                    checks["close_error"] = type(error).__name__
            checks["native_shutdown"] = rpc.process.returncode == 0 and (project / ".cache/health-shutdown.json").exists()
    checks["no_remaining_leases"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
    result = {"status": "pass" if checks and all(value is True for value in checks.values()) else "fail",
              "source_commit": manifest["source_commit"], "checks": checks, "observed": observed,
              "elapsed_seconds": round(time.monotonic() - started, 3), "root": str(root),
              "scope": ("Live nested-cwd validation preserves an intentional failure, executes later checks, keeps candidate clean, and handles parent attention/shutdown" if args.nested_checks else "Live existing-candidate review/QA, required check receipts, health consumption, shutdown and pool release; no implementation replay or user nudge")}
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
