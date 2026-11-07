#!/usr/bin/env python3
"""Qualify real Piccolo job completion -> health wake -> parent disposition.

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--compatibility", choices=["managed-0.85.1", "managed-0.86.1", "managed-1.3.0"], default="managed-1.3.0")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    if manifest.get("notifications") != "follow_up":
        raise RuntimeError("Health wake acceptance requires a fresh fixture prepared with --notifications follow_up")
    receipt = root / "health-jobs-acceptance.json"
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
    rpc = None
    checks = {}
    started = time.monotonic()
    try:
        rpc = jobs.Rpc(root, manifest)
        rpc.prompt('Use piccolo_submit exactly once, kind delegate, arguments type probe and task "Read README.md with the read tool and report its codeword. Do not modify files or use bash." Return immediately with the job ID. Do not poll or wait. When the harness later wakes you, inspect harness_health status, use piccolo_jobs result for the referenced job, verify its codeword HEALTH-PROBE-29, record resolved/verified_recovery for that attention incident, and reply REAL-JOB-RECOVERED HEALTH-PROBE-29. Do not run other tasks.')
        home = project / ".piccolo/jobs"
        created = list(home.iterdir())
        jobs.require(len(created) == 1, "Expected exactly one submitted job")
        job = created[0]
        def recovered():
            snapshots = (root / "state/pi-harness-health").glob("*/*.json")
            return any(i["component"] == "attention" and i["disposition"] == "resolved"
                       for p in snapshots for i in json.loads(p.read_text()).get("incidents", []))
        rpc.wait(recovered, 120)
        rpc.wait(lambda: any(e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"
                            and e["message"].get("stopReason") == "stop"
                            and any(c.get("type") == "text" and c.get("text", "").strip() == "REAL-JOB-RECOVERED HEALTH-PROBE-29"
                                    for c in e["message"].get("content", []) if isinstance(c, dict)) for e in rpc.events), 60)
        final_index = max(index for index, event in enumerate(rpc.events)
                          if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"
                          and event["message"].get("stopReason") == "stop"
                          and any(part.get("type") == "text" and part.get("text", "").strip() == "REAL-JOB-RECOVERED HEALTH-PROBE-29"
                                  for part in event["message"].get("content", []) if isinstance(part, dict)))
        rpc.wait(lambda: any(event.get("type") == "agent_settled" for event in rpc.events[final_index + 1:]), 30)
        checks["parent_settled"] = True
        outcome = json.loads((job / "outcome.json").read_text())
        entries = [json.loads(line) for line in (project / ".cache/jobs-rpc.jsonl").read_text().splitlines()]
        tool_calls = [c for e in entries for c in e.get("message", {}).get("content", []) if isinstance(c, dict) and c.get("type") == "toolCall"]
        checks.update({
            "one_submission": sum(c.get("name") == "piccolo_submit" for c in tool_calls) == 1,
            "job_completed": outcome["state"] == "completed",
            "child_model": outcome["result"]["model"] in [manifest["gpt_model"], manifest["gpt_model"] + ":medium"],
            "child_result": "HEALTH-PROBE-29" in json.dumps(outcome),
            "native_parent_wake": any(e.get("customType") == "harness-health-parent-start" for e in entries),
            "parent_consumed_result": any(c.get("name") == "piccolo_jobs" and c["arguments"].get("action") == "result" and c["arguments"].get("id") == job.name for c in tool_calls),
            "explicit_disposition": recovered(),
            "parent_final": True,
        })
    except (Exception, KeyboardInterrupt) as error:
        checks["runner_error"] = type(error).__name__
    finally:
        if rpc:
            if rpc.process.poll() is None:
                if not checks.get("parent_settled"):
                    rpc.send({"type": "abort"})
                    time.sleep(0.5)
                rpc.send({"type": "prompt", "message": "/health-acceptance-exit"})
            rpc.close()
            checks["native_shutdown"] = rpc.process.returncode == 0 and (project / ".cache/health-shutdown.json").exists()
    checks["no_remaining_leases"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
    result = {"status": "pass" if checks and all(value is True for value in checks.values()) else "fail",
              "source_commit": manifest["source_commit"], "checks": checks,
              "elapsed_seconds": round(time.monotonic() - started, 3), "root": str(root),
              "scope": "One real read-only SDK job, no user status nudge; workflow retries/TUI remain separate"}
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
