#!/usr/bin/env python3
"""Qualify a native supervisor handoff without replacing the child or job.

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
    parser.add_argument("--compatibility", choices=["managed", "native-v1", "managed-0.85.1", "managed-0.86.1", "managed-1.3.0", "managed-1.4.0"], default="managed")
    parser.add_argument("--case", choices=["reply", "cancel", "replace", "quit"], default="reply")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "fixture.json").read_text())
    if manifest.get("notifications") != "follow_up":
        raise RuntimeError("Health wake acceptance requires a fresh fixture prepared with --notifications follow_up")
    receipt = root / "supervisor-acceptance.json"
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
    rpc = None
    checks = {}
    started = time.monotonic()
    try:
        rpc = jobs.Rpc(root, manifest)
        task = 'Use piccolo_submit exactly once, kind delegate, arguments type probe and task "Use contact_supervisor to ask your parent for the missing acceptance codeword. Wait for the actual reply, then read README.md and report both codewords. Do not modify files." Return immediately with the job ID. Do not poll or wait. When the native supervisor requests input, use subagent_supervisor to reply SUPERVISOR-REPLY-73 to that exact request; do not launch replacement work. When harness health wakes you on completion, inspect its incident and piccolo_jobs result, verify HEALTH-PROBE-29 and SUPERVISOR-REPLY-73, acknowledge the exact outcome revision and resolve that attention incident as verified_recovery, then reply REAL-JOB-RECOVERED HEALTH-PROBE-29. Do not run other tasks.'
        if args.case == "cancel":
            task = task.replace("use subagent_supervisor to reply SUPERVISOR-REPLY-73 to that exact request", "do not reply to the child; instead call piccolo_jobs stop for the submitted job")
            task = task.replace("verify HEALTH-PROBE-29 and SUPERVISOR-REPLY-73", "verify the retained terminal state is cancelled and the child has shut down")
        if args.case in ["replace", "quit"]:
            task = task[:task.index("When the native supervisor requests input")] + "When the native supervisor requests input, reply exactly SUPERVISOR-WAITING without tools. Do not reply to the child, stop it or launch another job. Leave the child waiting."
        rpc.prompt(task)

        home = project / ".piccolo/jobs"
        created = list(home.iterdir())
        jobs.require(len(created) == 1, "Expected exactly one submitted job")
        job = created[0]
        if args.case in ["replace", "quit"]:
            rpc.wait(lambda: any(e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant" and any(c.get("type") == "text" and c.get("text", "").strip() == "SUPERVISOR-WAITING" for c in e["message"].get("content", []) if isinstance(c, dict)) for e in rpc.events), 120)
            checks["supervisor_requested"] = any(json.loads(p.read_text()).get("kind") == "tool_start" and json.loads(p.read_text()).get("tool") == "contact_supervisor" for p in job.glob("[0-9]*.json"))
            checks["no_premature_terminal"] = not (job / "outcome.json").exists()
            checks["lease_held_during_handoff"] = bool(list((root / "state/piccolo/pool").glob("*/slot-*.json")))
            if args.case == "replace":
                rpc.request("new_session")
                rpc.prompt("Reply exactly REPLACEMENT-USABLE without tools.")
                checks["replacement_usable"] = any(e.get("type") == "message_end" and "REPLACEMENT-USABLE" in json.dumps(e.get("message", {})) for e in rpc.events)
            else:
                rpc.send({"type": "prompt", "message": "/health-acceptance-exit"})
                deadline = time.monotonic() + 25
                while rpc.process.poll() is None and time.monotonic() < deadline:
                    rpc.pump()
                checks["quit_exited"] = rpc.process.poll() == 0
            checks["handoff_cancelled"] = (job / "outcome.json").exists() and json.loads((job / "outcome.json").read_text())["state"] == "cancelled"
            checks["child_shutdown"] = any(json.loads(p.read_text()).get("kind") == "child_shutdown" for p in job.glob("[0-9]*.json"))
            checks["no_leases_before_shutdown"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
            checks["all_launches_settled"] = all((p.parent / "outcome.json").is_file() for folder in ["jobs", "runs"] for p in (project / ".piccolo" / folder).glob("*/launch.json"))
            checks["parent_settled"] = True
        else:
            def recovered():
                snapshots = (root / "state/pi-harness-health").glob("*/*.json")
                return any(i["component"] == "attention" and i["disposition"] == "resolved"
                           for p in snapshots for i in json.loads(p.read_text()).get("incidents", []))
            rpc.wait(recovered, 120)
            rpc.wait(lambda: any(e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"
                                and e["message"].get("stopReason") == "stop"
                                and any(c.get("type") == "text" and c.get("text", "").strip().endswith("REAL-JOB-RECOVERED HEALTH-PROBE-29")
                                        for c in e["message"].get("content", []) if isinstance(c, dict)) for e in rpc.events), 60)
            final_index = max(index for index, event in enumerate(rpc.events)
                              if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"
                              and event["message"].get("stopReason") == "stop"
                              and any(part.get("type") == "text" and part.get("text", "").strip() == "REAL-JOB-RECOVERED HEALTH-PROBE-29"
                                      for part in event["message"].get("content", []) if isinstance(part, dict)))
            rpc.wait(lambda: any(event.get("type") == "agent_settled" for event in rpc.events[final_index + 1:]), 30)
            checks["parent_settled"] = True
            checks["no_leases_before_shutdown"] = not list((root / "state/piccolo/pool").glob("*/slot-*.json"))
            checks["all_launches_settled"] = all((p.parent / "outcome.json").is_file() for folder in ["jobs", "runs"] for p in (project / ".piccolo" / folder).glob("*/launch.json"))
            outcome = json.loads((job / "outcome.json").read_text())
            entries = [json.loads(line) for line in (project / ".cache/jobs-rpc.jsonl").read_text().splitlines()]
            tool_calls = [c for e in entries for c in e.get("message", {}).get("content", []) if isinstance(c, dict) and c.get("type") == "toolCall"]
            checks.update({
                "one_submission": sum(c.get("name") == "piccolo_submit" for c in tool_calls) == 1,
                "job_terminal": outcome["state"] == ("cancelled" if args.case == "cancel" else "completed"),
                "child_model": outcome["result"]["model"] in [manifest["gpt_model"], manifest["gpt_model"] + ":medium"],
                "child_result": args.case == "cancel" or ("HEALTH-PROBE-29" in json.dumps(outcome) and "SUPERVISOR-REPLY-73" in json.dumps(outcome)),
                "native_supervisor_action": any(c.get("name") == "subagent_supervisor" for c in tool_calls) if args.case == "reply" else any(c.get("name") == "piccolo_jobs" and c["arguments"].get("action") == "stop" for c in tool_calls),
                "supervisor_requested": any(json.loads(p.read_text()).get("tool") == "contact_supervisor" for p in job.glob("[0-9]*.json")),
                "one_child": sum(json.loads(p.read_text()).get("kind") == "child_shutdown" for p in job.glob("[0-9]*.json")) == 1,
                "native_parent_wake": any(e.get("customType") == "harness-health-parent-start" for e in entries),
                "parent_consumed_result": any(c.get("name") == "piccolo_jobs" and c["arguments"].get("action") == "result" and c["arguments"].get("id") == job.name for c in tool_calls),
                "explicit_disposition": recovered(),
                "parent_final": True,
            })

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
              "source_commit": manifest["source_commit"], "case": args.case, "checks": checks,
              "elapsed_seconds": round(time.monotonic() - started, 3), "root": str(root),
              "scope": "One live SDK supervisor request/reply and same-job completion, health consumption, shutdown and pool release; no user nudge"}
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
