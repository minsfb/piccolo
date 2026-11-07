#!/usr/bin/env python3
"""LIVE lifecycle probes. Retains native evidence for manual signoff, not a gate.

Use an owned qualification project with the candidate package composition. The
cancel probe starts one bounded sleeping child and asks its parent to stop it.
Review the exact run's terminal receipt and dead PID; parent prose is not proof.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("qualify-v0.1.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--case", required=True, choices=["cancel", "unavailable-child", "impossible-task"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--pi", default="pi")
    parser.add_argument("--output-dir", type=Path, help="New evidence directory inside the workspace; keeps Pi in the configured project")
    args = parser.parse_args()
    root = args.workspace.resolve(strict=True)
    directory = args.output_dir.resolve() if args.output_dir else root/args.case
    if not directory.is_relative_to(root):
        parser.error("Evidence directory must be inside the owned workspace")
    directory.mkdir(mode=0o700, parents=True)
    request = {"agent": "delegate", "async": False, "cwd": str(root), "context": "fresh", "timeoutMs": 120000}
    if args.case == "cancel":
        request.update({"async": True, "task": "Run bash command 'sleep 60'. After it completes, reply PICCOLO_SLEEP_FINISHED. Do nothing else."})
        after = "Inspect status/logs for at most 15 seconds to establish that this exact child began its bash sleep. Then call subagent action stop with the exact returned run id, and inspect that run status and bg_wait until terminal. Do not wait for its task to finish before stopping it. If startup fails or never reaches the sleeping tool, report blocked; do not launch another child or claim cancellation passed."
    elif args.case == "unavailable-child":
        request.update({"model": "piccolo-unavailable/model-does-not-exist", "task": "Reply PICCOLO_UNEXPECTED_SUCCESS."})
        after = "Report the expected model-resolution failure. Do not retry, substitute another model, or launch a second child."
    else:
        request["task"] = "Read definitely-missing-piccolo-input.txt using read. If it does not exist, report PICCOLO_EXPECTED_BLOCK and stop. Do not invent its contents or create files."
        after = "Report whether the child encountered the expected missing input. Do not fix the fixture."
    prompt = "Authorized lifecycle qualification: launch exactly one child using " + json.dumps(request) + ". " + after
    command = [args.pi,
               "--approve","--model",args.model,"--mode","json","--session",str(directory/"session.jsonl"),
               "--tools","subagent,bg_wait","-p",prompt]
    before = qualification.selection_digest()
    with (directory/"stdout.jsonl").open("x") as stdout, (directory/"stderr.log").open("x") as stderr:
        process = subprocess.Popen(command,cwd=root,stdout=stdout,stderr=stderr,start_new_session=True)
        timed_out = False
        interrupted = False
        try:
            code = process.wait(timeout=180)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            timed_out = isinstance(error, subprocess.TimeoutExpired)
            interrupted = isinstance(error, KeyboardInterrupt)
            os.killpg(process.pid, signal.SIGTERM)
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                code = process.wait()
    stream = qualification.events(directory/"stdout.jsonl")
    tools = [e for e in stream if e.get("type")=="tool_execution_end"]
    summary = {"case":args.case,"exit_code":code,"timed_out":timed_out,"interrupted":interrupted,
               "workspace":str(root),"evidence":str(directory),
               "startup_defaults_unchanged":before==qualification.selection_digest(),
               "tools":[{"name":e.get("toolName"),"isError":e.get("isError"),
                         "mode":e.get("result",{}).get("details",{}).get("mode")} for e in tools],
               "status":"needs_evidence_review","release_qualified":False}
    (directory/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
    print(json.dumps(summary))
    return 1 if timed_out or interrupted else code


if __name__ == "__main__":
    raise SystemExit(main())
