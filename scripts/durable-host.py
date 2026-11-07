#!/usr/bin/env python3
"""Own a managed Pi RPC process until its Durable service closes.

Supply the normal managed Pi command after --. Authentication, sandboxing and
deployment belong to that command. This wrapper owns only the RPC stdin lifetime.
"""
import json
import os
import queue
import signal
import subprocess
import sys
import threading


def main():
    command = sys.argv[1:]
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise SystemExit("usage: durable-host.py -- <managed pi RPC command>")
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)

    closing = threading.Event()
    timers = []

    def signal_group(sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass

    def terminate_group():
        signal_group(signal.SIGTERM)
        timer = threading.Timer(5, lambda: signal_group(signal.SIGKILL))
        timer.daemon = True
        timers.append(timer)
        timer.start()

    def close_input(*_args):
        if closing.is_set():
            return
        closing.set()
        if child.stdin and not child.stdin.closed:
            child.stdin.close()
        timer = threading.Timer(30, terminate_group)
        timer.daemon = True
        timers.append(timer)
        timer.start()

    signal.signal(signal.SIGTERM, close_input)
    signal.signal(signal.SIGINT, close_input)
    def startup_timeout():
        print(json.dumps({"type": "piccolo_worker_error", "error": "Worker startup did not report ready within 30 seconds"}), flush=True)
        close_input()

    startup = threading.Timer(30, startup_timeout)
    startup.daemon = True
    startup.start()
    # Managed Pi redirects extension stdout writes to stderr to protect RPC.
    # Drain both pipes: readiness must cancel the deadline on either stream.
    lines = queue.Queue()

    def read_stream(stream, is_stderr):
        try:
            for line in stream:
                lines.put((is_stderr, line))
        finally:
            lines.put((is_stderr, None))

    for stream, is_stderr in ((child.stdout, False), (child.stderr, True)):
        threading.Thread(target=read_stream, args=(stream, is_stderr), daemon=True).start()
    try:
        ended = 0
        while ended < 2:
            is_stderr, line = lines.get()
            if line is None:
                ended += 1
                continue
            try:
                event = json.loads(line)
            except ValueError:
                if is_stderr:
                    sys.stderr.write(line)
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") in ("piccolo_worker_ready", "piccolo_worker_closed", "piccolo_worker_error"):
                startup.cancel()
                print(json.dumps(event), flush=True)
            if event.get("type") in ("piccolo_worker_closed", "piccolo_worker_error"):
                close_input()
        return child.wait()
    finally:
        startup.cancel()
        close_input()
        if child.poll() is None:
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                signal_group(signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    signal_group(signal.SIGKILL)
                    child.wait()
        for timer in timers:
            timer.cancel()


if __name__ == "__main__":
    raise SystemExit(main())
