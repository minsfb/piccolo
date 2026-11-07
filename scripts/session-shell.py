#!/usr/bin/env python3
"""Bound one worker shell process group to its parent's private stdin pipe.

The SDK and models stay in Pi. This short-lived helper only supervises one shell
command. Node must spawn it in a new session; it remains that group's live leader
until the final group kill, so signaling never relies on a reused recorded PID.
"""
import json
import os
import selectors
import signal
import subprocess
import sys
import time
import traceback


def main():
    # A managed python launcher may fork instead of exec. Establish ownership
    # here as well; never signal the launcher's or the caller's process group.
    if os.getpid() != os.getsid(0):
        os.setsid()
    if os.getpid() != os.getsid(0) or os.getpid() != os.getpgrp():
        raise RuntimeError("Shell guard requires its own new process session")
    # A caught handler is reset to the default disposition in the exec'd shell.
    signal.signal(signal.SIGTERM, lambda *_: None)
    line = sys.stdin.buffer.readline(1024 * 1024 + 1)
    if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
        raise RuntimeError("Invalid shell request size")
    request = json.loads(line)
    if set(request) != {"command", "cwd", "timeout", "id", "receipt"} or not isinstance(request["command"], str):
        raise RuntimeError("Invalid shell request")
    timeout = request["timeout"]
    if timeout is not None and (not isinstance(timeout, (int, float)) or not 0 < timeout <= 86400):
        raise RuntimeError("Invalid shell timeout")
    process = subprocess.Popen(["/bin/bash", "-c", request["command"]], cwd=request["cwd"], stdin=subprocess.DEVNULL, close_fds=True)
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout if timeout else None
    reason = "completed"
    code = None
    while True:
        code = process.poll()
        if code is not None:
            break
        if deadline is not None and time.monotonic() >= deadline:
            reason = "timed_out"
            break
        if selector.select(0.05):
            if not os.read(0, 1024):
                reason = "aborted"
                break
    os.killpg(os.getpgrp(), signal.SIGTERM)
    time.sleep(0.2)
    code = process.poll() if code is None else code
    # A managed Python launcher need not preserve descriptor 3. Keep completion
    # independent of launcher pipes and retain it for inspection after failures.
    receipt = request["receipt"]
    pending = receipt + ".pending"
    with open(pending, "x", encoding="utf-8") as stream:
        os.chmod(pending, 0o600)
        json.dump({"format": 1, "id": request["id"], "reason": reason,
                   "exitCode": code, "guard_pid": os.getpid(),
                   "cleanup": "group_kill_requested"}, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.link(pending, receipt)
    os.unlink(pending)
    os.killpg(os.getpgrp(), signal.SIGKILL)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stderr.flush()
        # Even an unexpected exception must not abandon an already spawned shell.
        if os.getpid() == os.getpgrp() == os.getsid(0):
            os.killpg(os.getpgrp(), signal.SIGKILL)
        raise
