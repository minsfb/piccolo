#!/usr/bin/env python3
"""Owned live Pi qualification. One initial prompt; no user/status nudges.

Run with the normal managed Pi executable. Does not replace its launcher or
modify existing agent directories. Evidence remains in a newly created fixture.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--pi", default="pi")
    parser.add_argument("--models-extension", type=Path)
    parser.add_argument("--compatibility", default="off")
    parser.add_argument("--diagnostic", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    package = args.package.resolve()
    project = root / "project"
    for directory in [project / ".pi", root / "agent", root / "config", root / "state"]:
        directory.mkdir(parents=True, mode=0o700)
    probe = root / "probe.ts"
    probe.write_text('''import fs from "node:fs";
export default function probe(pi) {
 pi.events.on("pi-harness-health:inspect:v1", request => {
   request.observations = [{source:"acceptance-missed-callback",component:"attention",code:"unacknowledged"}];
 });
 pi.on("session_shutdown", () => fs.writeFileSync("shutdown.json", JSON.stringify({shutdown:true})));
 pi.registerCommand("health-acceptance-exit", {description:"End owned acceptance",handler:async(_args,ctx)=>ctx.shutdown()});
}
''')
    settings = {"packages": [str(package)], "extensions": [str(probe)]}
    if args.models_extension:
        settings["extensions"].append(str(args.models_extension.resolve()))
    (project / ".pi/settings.json").write_text(json.dumps(settings))
    config = "interval_ms = 1000\nattention_ms = 15000\nretry_ms = 1000\nmax_attempts = 3\n"
    if args.compatibility != "off":
        config += "compatibility = " + json.dumps(args.compatibility) + "\n"
    if args.diagnostic:
        config += "[diagnostic]\nenabled = true\ninterval_ms = 1000\nmax_calls = 1\nmodel = " + json.dumps(args.model) + "\n"
    (project / ".pi/health.toml").write_text(config)
    (project / "AGENTS.md").write_text("Owned harness-health acceptance fixture. Do not run project tasks, shell commands, or modify files. Handle the synthetic health incident using only harness_health.\n")
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), XDG_CONFIG_HOME=str(root / "config"), XDG_STATE_HOME=str(root / "state"))
    argv = [args.pi, "--approve", "--mode", "rpc", "--model", args.model, "--session", str(root / "session.jsonl")]
    prompt = "This is an isolated harness-health acceptance. Reply exactly PARENT-INITIAL and finish this turn. Do not inspect health or start other work now. If the harness later wakes you, call harness_health status, then record resolved/verified_recovery for the synthetic attention/unacknowledged acceptance incident; no project work is required. Finally reply PARENT-RECOVERED. Do not use bash or any other tools."
    started = time.monotonic()
    outcome = {"status": "fail", "forced_cleanup": False, "model": args.model, "compatibility": args.compatibility, "scope": "Live idle-parent recovery from a synthetic missed callback; one initial prompt only", "root": str(root)}
    manifest = json.loads((package / "package.json").read_text())
    outcome["package_version"] = manifest["version"]
    outcome["source_sha256"] = hashlib.sha256(b"".join(p.relative_to(package).as_posix().encode() + b"\0" + p.read_bytes() for p in sorted(package.rglob("*.ts")) if "node_modules" not in p.parts)).hexdigest()
    with (root / "stdout.jsonl").open("w") as stdout, (root / "stderr.log").open("w") as stderr:
        proc = subprocess.Popen(argv, cwd=project, env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True)
        try:
            proc.stdin.write(json.dumps({"type": "prompt", "message": prompt}) + "\n")
            proc.stdin.flush()
            while time.monotonic() - started < 100 and proc.poll() is None:
                records = []
                for p in (root / "state/pi-harness-health").glob("*/*.json"):
                    try:
                        records.extend(json.loads(p.read_text()).get("incidents", []))
                    except (ValueError, OSError):
                        pass
                targets = [i for i in records if i["component"] == "attention" and i["code"] == "unacknowledged"]
                if targets and targets[0]["disposition"] == "resolved":
                    try:
                        native_entries = [json.loads(line) for line in (root / "session.jsonl").read_text().splitlines()]
                    except (ValueError, OSError):
                        native_entries = []
                    events = []
                    for line in (root / "stdout.jsonl").read_text().splitlines():
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            pass  # A final stream line may still be being written.
                    final_indices = [index for index, event in enumerate(events)
                                     if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"
                                     and event["message"].get("stopReason") == "stop"
                                     and any(part.get("type") == "text" and part.get("text", "").strip() == "PARENT-RECOVERED"
                                             for part in event["message"].get("content", []) if isinstance(part, dict))]
                    outcome["parent_final"] = bool(final_indices)
                    outcome["parent_settled"] = bool(final_indices) and any(event.get("type") == "agent_settled" for event in events[final_indices[-1] + 1:])
                    diagnostic_finished = not args.diagnostic or any(e.get("customType") in ("harness-health-diagnosis", "harness-health-diagnostic-failure") for e in native_entries)
                    if outcome["parent_final"] and outcome["parent_settled"] and diagnostic_finished:
                        outcome["status"] = "pass"
                        break
                if targets and targets[0]["reason"] == "unsupported_recovery" and not args.diagnostic:
                    outcome["status"] = "blocked"
                    outcome["reason"] = "Managed runtime lacks the qualified wake bridge"
                    break
                time.sleep(0.25)
            outcome["elapsed_seconds"] = round(time.monotonic() - started, 3)
            outcome["process_alive_before_shutdown"] = proc.poll() is None
        finally:
            if proc.poll() is None:
                if not outcome.get("parent_settled"):
                    proc.stdin.write(json.dumps({"type": "abort"}) + "\n")
                    proc.stdin.flush()
                    time.sleep(0.5)
                proc.stdin.write(json.dumps({"type": "prompt", "message": "/health-acceptance-exit"}) + "\n")
                proc.stdin.flush()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    outcome["forced_cleanup"] = True
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
            outcome["exit_code"] = proc.returncode
            outcome["shutdown_hook"] = (project / "shutdown.json").exists()
    session = root / "session.jsonl"
    entries = [json.loads(line) for line in session.read_text().splitlines()] if session.exists() else []
    outcome["parent_wake_acknowledged"] = any(e.get("customType") == "harness-health-parent-start" for e in entries)
    outcome["diagnostic_observed"] = any(e.get("customType") == "harness-health-diagnosis" for e in entries)
    if outcome["status"] == "pass" and (not outcome.get("parent_final") or not outcome.get("parent_settled") or not outcome["parent_wake_acknowledged"] or not outcome["shutdown_hook"] or outcome["exit_code"] != 0 or outcome["forced_cleanup"]):
        outcome["status"] = "fail"
    if args.diagnostic and not outcome["diagnostic_observed"]:
        outcome["diagnostic_status"] = "not_observed"
        outcome["status"] = "fail"
    (root / "receipt.json").write_text(json.dumps(outcome, indent=2) + "\n")
    print(json.dumps(outcome, indent=2))


if __name__ == "__main__":
    main()
