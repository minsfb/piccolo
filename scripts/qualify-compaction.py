#!/usr/bin/env python3
"""LIVE native Pi RPC compaction probe in an owned, preconfigured fixture.

Uses real managed models. Stores private RPC/session streams in a new case
directory. Does not install packages, alter profiles, or change authentication.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--owner", choices=["blackhole", "pi"], required=True)
    parser.add_argument("--probe-extension", type=Path)
    args = parser.parse_args()
    root = args.workspace.resolve(strict=True)
    directory = root / args.case
    directory.mkdir(mode=0o700)
    command = ["pi", "--approve", "--mode", "rpc", "--model", args.model,
               "--session", str(directory / "session.jsonl"), "--tools", ""]
    if args.probe_extension:
        command += ["-e", str(args.probe_extension.resolve(strict=True))]
    inbox = queue.Queue()
    history = []
    with (directory / "stderr.log").open("x") as stderr, (directory / "stdout.jsonl").open("x") as capture:
        process = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=stderr, text=True,
                                   start_new_session=True)

        def read_output():
            for line in process.stdout:
                capture.write(line)
                capture.flush()
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                inbox.put(value)
            inbox.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        def request(body, turn=False):
            identity = str(time.monotonic_ns())
            process.stdin.write(json.dumps({"id": identity, **body}) + "\n")
            process.stdin.flush()
            deadline = time.monotonic() + 180
            reply = None
            ended = False
            start = len(history)
            while reply is None or (turn and not ended):
                event = inbox.get(timeout=max(0.01, deadline - time.monotonic()))
                if event is None:
                    raise RuntimeError("RPC ended before the requested operation completed")
                history.append(event)
                if event.get("type") == "response" and event.get("id") == identity:
                    reply = event
                    if not reply.get("success"):
                        raise RuntimeError("RPC command failed: " + body["type"])
                if event.get("type") == "agent_end":
                    ended = True
            return reply, history[start:]

        try:
            request({"type": "get_state"})
            request({"type": "prompt", "message": "Remember this project decision: the release codeword is CEDAR-42. The user requires preserving this exact codeword across compaction. Reply ACK only."}, turn=True)
            filler = "\n".join(f"Fixture note {i}: reversible synthetic qualification data; preserve the release codeword." for i in range(120))
            request({"type": "prompt", "message": filler + "\nReply ACK only."}, turn=True)
            compact, _ = request({"type": "compact"})
            _, continuation = request({"type": "prompt", "message": "What is the release codeword from the earlier project decision? Reply with the codeword only."}, turn=True)
            answers = [e.get("message", {}) for e in continuation if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"]
            answer = " ".join(c.get("text", "") for m in answers for c in m.get("content", []) if c.get("type") == "text")
            details = compact.get("data", {}).get("details", {})
            blackhole = details.get("compactor") == "blackhole"
            checks = {"compact_succeeded": compact.get("success") is True,
                      "expected_owner": blackhole if args.owner == "blackhole" else not blackhole,
                      "continued_with_codeword": "CEDAR-42" in answer}
            report = {"case": args.case, "model": args.model, "owner": args.owner,
                      "checks": checks, "compaction_detail_keys": sorted(details),
                      "status": "pass" if all(checks.values()) else "fail"}
            (directory / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report), flush=True)
            return 0 if report["status"] == "pass" else 1
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            reader.join(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
