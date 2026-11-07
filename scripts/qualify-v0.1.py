#!/usr/bin/env python3
"""Opt-in LIVE managed Pi qualification; raw streams stay in an owned directory.

Uses the installed launcher and its existing provider/authentication configuration.
Does not install packages, change defaults, or disable sandboxing. A successful
subset is not release signoff. See docs/setup-v0.1.md for remaining acceptance.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {"sum": 42, "instructionMarker": "piccolo-fixture-v1"}


def events(path):
    result = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def selection_digest():
    path = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home()/".pi/agent")))/"settings.json"
    settings = json.loads(path.read_text()) if path.exists() else {}
    selected = {k: settings.get(k) for k in ("defaultProvider", "defaultModel", "defaultThinkingLevel")}
    return hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()


def child_evidence(stream, workspace, expected):
    rows = [r for e in stream if e.get("type") == "tool_execution_end"
            for r in e.get("result", {}).get("details", {}).get("results", [])]
    for event in stream:
        if event.get("type") != "tool_execution_end":
            continue
        for completion in event.get("result", {}).get("details", {}).get("completions", []):
            rows.extend(completion.get("results", []))
    evidence = []
    seen = set()
    for row in rows:
        filename = row.get("sessionFile")
        if not filename:
            continue
        path = Path(filename).resolve()
        if not path.is_relative_to(workspace) or not path.is_file():
            continue
        if path in seen:
            continue
        seen.add(path)
        entries = events(path)
        messages = [e["message"] for e in entries if e.get("type") == "message"]
        assistants = [m for m in messages if m.get("role") == "assistant"]
        observed = sorted({f'{m.get("provider")}/{m.get("model")}' for m in assistants})
        effects = [m for m in messages if m.get("role") == "toolResult"]
        item = {"models": observed,
                "thinking": [e.get("thinkingLevel") for e in entries if e.get("type") == "thinking_level_change"],
                "checks": {
                    "expected_model": observed == [expected],
                    "child_exit_zero": row.get("exitCode") == 0 or row.get("success") is True,
                    "child_completed": bool(assistants) and assistants[-1].get("stopReason") == "stop",
                    "child_cwd": any(e.get("type") == "session" and e.get("cwd") == str(workspace) for e in entries),
                    "child_write": any(m.get("toolName") == "write" and not m.get("isError") for m in effects),
                }}
        evidence.append(item)
    return evidence


def delegation_prompt(request):
    prompt = ("This is an authorized live delegation qualification. Copy ALL fields in the following JSON into one subagent call,"
              " including the required explicit async boolean: " + json.dumps(request)
              + ". Do not perform the child's task yourself. Report the returned result briefly.")
    if request["async"]:
        return prompt + " Wait for that child to finish using bg_wait; inspect its terminal status before responding."
    return prompt + (" This is synchronous delegation: the subagent tool returns the completed child's result."
                     " After that one tool call, respond immediately without any further tool calls."
                     " A completed result with '(no output)' is valid: report it as such; the external verifier checks the file."
                     " Do not poll it with action:status, bg_wait,"
                     " or a workflowScript; a synchronous result ID is not an async run ID."
                     " If the call fails, report the failure without retrying or launching another child.")


def requested_execution_path(stream, background):
    calls = [e for e in stream if e.get("type") == "tool_execution_start"]
    launches = [e for e in calls if e.get("toolName") == "subagent" and e.get("args", {}).get("agent")
                and not e.get("args", {}).get("action")]
    return (len(launches) == 1 and launches[0].get("args", {}).get("async") is background
            and (background or len(calls) == 1))


def run_case(args, name, parent, child=None, background=False):
    directory = args.workspace / name
    directory.mkdir(mode=0o700)  # Never overwrite prior test evidence.
    for filename in ("AGENTS.md", "input.json"):
        shutil.copyfile(ROOT / "tests/fixtures/delegation" / filename, args.workspace / filename)
    output = name + "-result.json"
    if (args.workspace / output).exists():
        raise ValueError("Fixture output already exists")
    task = (f"Perform the calculation task described in AGENTS.md; write {output}."
            " After writing, return a short confirmation with the output filename.")
    if child is not None:
        request = {"agent": "delegate", "task": task, "async": background,
                   "context": "fresh", "cwd": str(args.workspace), "timeoutMs": 180000}
        if child != "inherit":
            request["model"] = child
        prompt = delegation_prompt(request)
        allowed = "subagent,bg_wait" if background else "subagent"
    else:
        prompt, allowed = task, "read,write"
    command = [args.pi, "--approve", "--mode", "json", "--session", str(directory / "session.jsonl"),
               "-e", str(ROOT / "tests/support/runtime-metadata.ts"), "--tools", allowed, "-p", prompt]
    if parent:
        command[1:1] = ["--model", parent]
    before = selection_digest()
    started = time.monotonic()
    with (directory / "stdout.jsonl").open("x") as stdout, (directory / "stderr.log").open("x") as stderr:
        env = dict(os.environ)
        if child is not None:
            env["PICCOLO_QUALIFY_ASYNC"] = str(background).lower()
        else:
            env.pop("PICCOLO_QUALIFY_ASYNC", None)
        process = subprocess.Popen(command, cwd=args.workspace, stdout=stdout, stderr=stderr, env=env, start_new_session=True)
        try:
            code = process.wait(timeout=args.timeout)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                code = process.wait()
    stream = events(directory / "stdout.jsonl")
    messages = [e["message"] for e in stream if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"]
    tools = [e for e in stream if e.get("type") == "tool_execution_end"]
    models = sorted({f'{m.get("provider")}/{m.get("model")}' for m in messages})
    session_path = directory / "session.jsonl"
    metadata = [e["data"] for e in events(session_path) if e.get("customType") == "piccolo-qualification-metadata"] if session_path.exists() else []
    try:
        actual = json.loads((args.workspace / output).read_text())
    except (OSError, ValueError):
        actual = None
    checks = {
        "exit_zero": code == 0,
        "within_deadline": not timed_out,
        "assistant_completed": bool(messages) and messages[-1].get("stopReason") == "stop",
        "fixture_effect": actual == EXPECTED,
        "explicit_parent_model": parent is None or models == [parent],
        "startup_defaults_unchanged": before == selection_digest(),
        "metadata_observed": len(metadata) >= 2,
        "parent_selection_unchanged": bool(metadata) and all((m.get("provider"),m.get("model")) == (metadata[0].get("provider"),metadata[0].get("model")) for m in metadata),
        "tool_completed": bool(tools) and not any(e.get("isError") for e in tools),
    }
    if child is not None:
        checks["requested_execution_path"] = requested_execution_path(stream, background)
        checks["delegation_called"] = any(e.get("toolName") == "subagent" for e in tools)
        expected_child = models[0] if child == "inherit" and len(models) == 1 else child
        children = child_evidence(stream, args.workspace, expected_child)
        checks["child_identity_and_effects"] = len(children) == 1 and all(children[0]["checks"].values())
        if background:
            checks["background_wait_called"] = any(e.get("toolName") == "bg_wait" for e in tools)
    else:
        children = []
    report = {"case": name, "requested_parent": parent or "native", "requested_child": child,
              "observed_parent_models": models, "effort": [m.get("thinking") for m in metadata],
              "elapsed_seconds": round(time.monotonic()-started, 2), "exit_code": code,
              "checks": checks, "status": "pass" if all(checks.values()) else "fail",
              "child_identity_verified": None if child is None else checks["child_identity_and_effects"],
              "children": children,
              "raw_evidence": name}
    (directory / "summary.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report), flush=True)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True, help="Owned project with pi-subagents installed locally")
    parser.add_argument("--pi", default="pi")
    parser.add_argument("--gpt", required=True)
    parser.add_argument("--claude", required=True)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--case", action="append", choices=["native", "gpt", "claude", "inherit", "gpt-gpt", "gpt-claude", "claude-gpt", "claude-claude", "background-gpt", "background-claude"])
    args = parser.parse_args()
    args.workspace = args.workspace.resolve(strict=True)
    cases = {"native": (None,None), "gpt": (args.gpt,None), "claude": (args.claude,None),
             "inherit": (None,"inherit"), "gpt-gpt": (args.gpt,args.gpt), "gpt-claude": (args.gpt,args.claude),
             "claude-gpt": (args.claude,args.gpt), "claude-claude": (args.claude,args.claude),
             "background-gpt": (args.gpt,args.gpt,True), "background-claude": (args.gpt,args.claude,True)}
    reports = [run_case(args, name, *cases[name]) for name in (args.case or cases)]
    summary = {"date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "release_qualified": False, "cases": reports}
    suite_name = "+".join(args.case or cases)
    (args.workspace / (suite_name + ".summary.json")).write_text(json.dumps(summary, indent=2)+"\n")
    return 0 if all(r["status"] == "pass" for r in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
