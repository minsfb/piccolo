#!/usr/bin/env python3
"""Run native experiment qualification in a fresh prepared session-jobs fixture."""
import argparse
import importlib.util
import json
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location("jobs", Path(__file__).with_name("acceptance-session-jobs.py"))
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--workflow", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    project = root / "project"
    manifest = json.loads((root / "fixture.json").read_text())
    receipt = root / "experiment-acceptance.json"
    if receipt.exists() or (project / ".cache/jobs-rpc.jsonl").exists():
        raise RuntimeError("Preserve earlier run; prepare a fresh fixture")
    settings_path = project / ".pi/settings.json"
    settings = json.loads(settings_path.read_text())
    settings["packages"].append(str(root / "source/packages/health"))
    probe = root / "exit-probe.ts"
    probe.write_text('import fs from "node:fs"; export default function(pi) { pi.registerCommand("experiment-exit", {description:"Exit owned qualification",handler:async(_args,ctx)=>ctx.shutdown()}); pi.on("session_shutdown",()=>fs.writeFileSync(".cache/experiment-shutdown.json","{}")); }\n')
    settings["extensions"].append(str(probe))
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    # Owned fixture config; no global installation changes.
    with (project / ".piccolo/config.toml").open("a") as f:
        f.write('\n[extensions.pi-harness-health]\ninterval_ms = 1000\nattention_ms = 30000\ncompatibility = "managed-0.86.1"\n')
    experiment = 'format = 1\nname = "native-experiment"\nrepetitions = 2\n'
    if args.workflow:
        experiment += '''
[tasks.arithmetic]
kind = "workflow"
task = "Create sum.mjs exporting sum(a,b), plus check.mjs using node:assert/strict to verify 2+3=5 and -2+2=0. Commit these files. No installation, network, services, push or merge. Independent review/QA inspect correctness and the pure local check; the harness runs node check.mjs after QA. Return the required stage report."
[tasks.arithmetic.criterion]
kind = "required_checks"
[tasks.arithmetic.checks.arithmetic]
command = "node check.mjs"
boundary = "isolated"
scope = "Pure local arithmetic assertions in owned fixture"
timeout_ms = 10000
[variants.baseline]
'''
    else:
        experiment += '''
[tasks.marker]
kind = "delegate"
type = "probe"
task = "Reply exactly EXPERIMENT-OK. Do not call any tools."
[tasks.marker.criterion]
kind = "exact_text"
expected = "EXPERIMENT-OK"
'''
        for name, model in [("gpt", manifest["gpt_model"]), ("claude", manifest["claude_model"])]:
            override = 'model = ' + json.dumps(model) + '\ncontext = "fresh"\ntools = []'
            experiment += '\n[variants.' + name + ']\ndelegate_overrides_toml = ' + json.dumps(override) + '\n'
    (project / "experiment.toml").write_text(experiment)
    jobs.checked(["git", "add", "experiment.toml", ".piccolo/config.toml"], project)
    jobs.checked(["git", "-c", "user.name=Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-m", "Prepare experiment inputs"], project)
    jobs.checked(["node", str(root / "source/bin/piccolo.mjs"), "configure", "--cwd", str(project)], project, jobs.environment(root))
    rpc = None
    checks = {}
    report = None
    started = time.monotonic()
    try:
        rpc = jobs.Rpc(root, manifest)
        rpc.prompt('Call piccolo_submit exactly once with {"kind":"experiment","arguments":{"spec":"experiment.toml"}}. Return immediately with the ID. Do not poll or wait or modify files. When harness health wakes you, inspect the incident and exact job result, acknowledge its outcome revision and resolve the incident after handling it. Report EXPERIMENT-HANDLED. Do not submit any further work or rerun failures.')
        def handled():
            return any(i.get("component") == "attention" and i.get("disposition") in {"resolved", "development"}
                       for p in (root / "state/pi-harness-health").glob("*/*.json") for i in json.loads(p.read_text()).get("incidents", []))
        rpc.wait(handled, 600)
        rpc.wait(lambda: any(e.get("type") == "agent_settled" for e in rpc.events[-4:]), 60)
        checks["parent_settled"] = True
        all_jobs = list((project / ".piccolo/jobs").glob("*/outcome.json"))
        checks["one_submission"] = len(all_jobs) == 1
        outcome = json.loads(all_jobs[0].read_text())
        checks["job_completed"] = outcome["state"] == "completed"
        result = outcome["result"]
        report = json.loads(jobs.checked(["node", str(root / "source/bin/piccolo.mjs"), "experiment", "report", "--id", result["id"]], project, jobs.environment(root)))
        expected = 2 if args.workflow else 4
        checks["all_trials_recorded"] = len(report["trials"]) == expected
        checks["all_criteria_passed"] = sum(g["correctness_pass"] for g in report["groups"]) == expected
        checks["usage_retained"] = all(t["metrics"]["usage"] is not None for t in report["trials"])
        checks["separate_worktrees"] = len(list(Path(result["record"]).joinpath("worktrees").iterdir())) == expected
        if not args.workflow:
            observed = {t["provenance"]["observed_model"].rsplit(":", 1)[0] for t in report["trials"]}
            checks["both_models"] = observed == {manifest["gpt_model"], manifest["claude_model"]}
        entries = [json.loads(line) for line in (project / ".cache/jobs-rpc.jsonl").read_text().splitlines()]
        calls = [c for e in entries for c in e.get("message", {}).get("content", []) if isinstance(c, dict) and c.get("type") == "toolCall"]
        decisions = [json.loads(p.read_text()) for p in all_jobs[0].parent.glob("[0-9]*.json")]
        revision = next(d["revision"] for d in decisions if d.get("kind") == "parent_decision" and d.get("disposition") == "acknowledged")
        checks["exact_ack"] = any(c.get("name") == "piccolo_jobs" and c.get("arguments", {}).get("action") == "ack"
                                  and c.get("arguments", {}).get("id") == outcome["id"]
                                  and c.get("arguments", {}).get("revision") == revision for c in calls)
        checks["native_parent_wake"] = any(e.get("customType") == "harness-health-parent-start" for e in entries)
        checks["no_leases_before_shutdown"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
    except (Exception, KeyboardInterrupt) as error:
        checks["runner_error"] = type(error).__name__
    finally:
        if rpc:
            try:
                if rpc.process.poll() is None:
                    rpc.send({"type": "abort"})
                    rpc.send({"type": "prompt", "message": "/experiment-exit"})
                    deadline = time.monotonic() + 25
                    while rpc.process.poll() is None and time.monotonic() < deadline:
                        rpc.pump()
                checks["no_forced_cleanup"] = rpc.process.poll() is not None
            finally:
                rpc.close()
            checks["native_shutdown"] = rpc.process.returncode == 0 and (project / ".cache/experiment-shutdown.json").exists()
    checks["no_remaining_leases"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
    result = {"status": "pass" if checks and all(v is True for v in checks.values()) else "fail", "source_commit": manifest["source_commit"], "checks": checks, "report": report, "elapsed_seconds": round(time.monotonic()-started,3)}
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k:v for k,v in result.items() if k != "report"}, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
