#!/usr/bin/env python3
"""Provide an owned Chrome for Testing instance to a sandboxed Pi via CDP.

Run from a normal Mac terminal, alongside acceptance-mac.py session. Ctrl-C
stops this helper's browser. --check inspects prerequisites without launching.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(file, value):
    with tempfile.NamedTemporaryFile(mode="w", prefix=file.name + ".", dir=file.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(json.dumps(value, indent=2) + "\n")
    try:
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def inspect_kit(root, chosen=None):
    root = root.resolve(strict=True)
    kit = json.loads((root / "kit.json").read_text())
    if kit.get("root") != str(root):
        raise ValueError("Kit moved; its package references need reconciliation")
    project = (root / "project").resolve(strict=True)
    if project != root / "project":
        raise ValueError("The kit project must not be symlinked")
    runtime = project / ".cache/playwright-cli"
    candidates = [chosen] if chosen else list((runtime / "browsers").glob(
        "chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
    if len(candidates) != 1:
        raise ValueError("Expected one installed Chrome for Testing; select an owned binary with --browser")
    browser = candidates[0].resolve(strict=True)
    if not browser.is_relative_to(root) or not browser.is_file() or not os.access(browser, os.X_OK):
        raise ValueError("Browser must be an executable in this kit")
    cli = (runtime / "node_modules/.bin/playwright-cli").resolve(strict=True)
    if not cli.is_relative_to(root):
        raise ValueError("Playwright CLI must belong to this kit")
    node = shutil.which("node")
    lsof = shutil.which("lsof") or "/usr/sbin/lsof"
    if not node or not Path(lsof).is_file():
        raise ValueError("Node and lsof are required")
    return root, project, browser, cli, node, lsof


def browser_command(browser, profile):
    return [str(browser), "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
            "--user-data-dir=" + str(profile), "--no-first-run", "--no-default-browser-check", "about:blank"]


def parse_endpoint(text):
    lines = text.splitlines()
    if len(lines) != 2 or not lines[0].isdigit():
        raise ValueError("Incomplete DevToolsActivePort file")
    port = int(lines[0])
    if not 1 <= port <= 65535 or not re.fullmatch(r"/devtools/browser/[a-zA-Z0-9-]+", lines[1]):
        raise ValueError("Invalid DevToolsActivePort identity")
    return port, lines[1]


def verify_version(value, port, browser_path):
    url = urllib.parse.urlsplit(value.get("webSocketDebuggerUrl", ""))
    if (url.scheme != "ws" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.port != port or url.path != browser_path or url.query or url.fragment
            or url.username or url.password):
        raise ValueError("CDP endpoint does not match this profile's browser identity")
    if not re.fullmatch(r"(?:Headless)?Chrome/[0-9.]+", value.get("Browser", "")):
        raise ValueError("CDP endpoint did not identify Chrome")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected redirect from owned browser endpoint")


def verify_listener(lsof, pid, port):
    result = subprocess.run([lsof, "-nP", "-a", "-p", str(pid), "-iTCP:" + str(port),
                             "-sTCP:LISTEN", "-Fn"], capture_output=True, text=True, timeout=5)
    names = [line[1:] for line in result.stdout.splitlines() if line.startswith("n")]
    allowed = {f"127.0.0.1:{port}", f"[::1]:{port}", f"localhost:{port}"}
    if result.returncode or not names or any(name not in allowed for name in names):
        raise ValueError("Could not verify that the owned browser listens only on loopback")


def wait_ready(process, profile, lsof, timeout):
    deadline = time.monotonic() + timeout
    # Loopback traffic must stay local, regardless of unrelated ambient proxies.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Chrome exited before readiness; inspect chrome.log")
        try:
            port, browser_path = parse_endpoint((profile / "DevToolsActivePort").read_text())
        except (OSError, ValueError):
            time.sleep(0.1)
            continue
        verify_listener(lsof, process.pid, port)
        endpoint = f"http://127.0.0.1:{port}"
        try:
            with client.open(endpoint + "/json/version", timeout=2) as reply:
                value = json.loads(reply.read(65536))
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.1)
            continue
        verify_version(value, port, browser_path)
        if process.poll() is not None:
            raise RuntimeError("Chrome exited during readiness verification")
        return endpoint, value["Browser"]
    raise RuntimeError("Chrome readiness deadline exceeded; inspect chrome.log")


def stop_owned(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def worker_instructions(record):
    attach = shlex.join(record["attach_argv"])
    detach = shlex.join(record["detach_argv"])
    return f'''# Case 6 retry: externally hosted Chrome

The operator launched a dedicated Chrome for Testing from a normal Mac terminal.
The main Pi and browser worker retain their managed sandbox. This changes browser
provisioning, not the acceptance criteria. The host receipt is {record["receipt"]}.

Delegate this retry to browser_qa. Treat these task instructions as the explicit
attachment mode for the existing browser-evidence skill. Do not use `open`, launch
another browser, disable any sandbox, or substitute personal browser profiles.

1. Read .cache/piccolo/browser-host/active.json and require status ready and this
   run ID: {record["id"]}. Read the current host receipt too. If stopped or changed,
   report blocked rather than using stale coordinates.
2. Attach to the supplied endpoint using this exact owned CLI and named session:

   {attach}

3. Recheck the existing test preview URL from the acceptance ledger. If its owned
   preview server stopped, restart only the synthetic fixture server using an
   available loopback port. Do not assume port 53121 is still current.
4. Navigate using the attached session. Exercise the existing Count 0 -> Count 2
   flow. Save a new screenshot, DOM snapshot and console evidence under
   {record["evidence_directory"]}. Keep earlier blocked evidence intact.
5. Return concise findings and file references. The parent must delegate the
   screenshot path to screenshot_reviewer and verify an actual image-read content
   block in the child session, then record artifact hashes/source attribution.
6. Detach with the exact named-session command:

   {detach}

Do not use `close`, close-all, kill-all or terminate the host browser; its owner
will stop it with Ctrl-C in the separate terminal after review. A connection or
port denial remains a blocked test, not grounds for changing sandbox policy.
The host's ready status proves browser startup only; it does not pass Case 6.
Record success only after actual interactions and screenshot evidence exist.
'''


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--browser", type=Path, help="Choose a Chrome for Testing binary inside this kit")
    parser.add_argument("--check", action="store_true", help="Check paths only; do not start browser or write state")
    parser.add_argument("--startup-timeout", type=int, default=60)
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This browser host is for macOS")
    if not 1 <= args.startup_timeout <= 300:
        parser.error("--startup-timeout must be between 1 and 300 seconds")
    root, project, browser, cli, node, lsof = inspect_kit(args.root, args.browser)
    if args.check:
        print(json.dumps({"status": "prerequisites_found", "browser": str(browser), "cli": str(cli),
                          "live_browser_tested": False}, indent=2))
        return 0
    storage = project
    for part in (".cache", "piccolo", "browser-host"):
        storage = storage / part
        storage.mkdir(exist_ok=True)
        if storage.is_symlink():
            raise ValueError("Browser host storage must not be symlinked")
    with (storage / "host.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A browser helper already owns this kit; use its active.json")
        active = storage / "active.json"
        if active.exists() and json.loads(active.read_text()).get("status") in ("starting", "ready", "needs_reconciliation"):
            raise RuntimeError("A prior host receipt is unfinished. Reconcile that exact browser before starting another helper.")
        directory = Path(tempfile.mkdtemp(prefix="run-", dir=storage))
        profile = directory / "profile"
        profile.mkdir()
        evidence = directory / "evidence"
        evidence.mkdir()
        record = {"format": 1, "id": directory.name, "status": "starting", "created_at": now(),
                  "browser": str(browser), "profile": str(profile), "receipt": str(directory / "host.json"),
                  "evidence_directory": str(evidence), "instructions": str(directory / "instructions.md"),
                  "owner": "normal-terminal browser helper", "sandbox_disable_flags": False,
                  "case6_passed": False}
        write_json(directory / "host.json", record)
        write_json(active, record)
        process = None
        result = 0
        def interrupted(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGHUP, interrupted)
        try:
            with (directory / "chrome.log").open("x") as log:
                process = subprocess.Popen(browser_command(browser, profile), cwd=project,
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                record["pid"] = process.pid
                write_json(directory / "host.json", record)
                write_json(active, record)
                endpoint, version = wait_ready(process, profile, lsof, args.startup_timeout)
                record.update(status="ready", endpoint=endpoint, browser_version=version,
                              ready_at=now(), listener_verified=True)
                name = "piccolo-" + directory.name
                record["attach_argv"] = [node, str(cli), "-s=" + name, "attach", "--cdp=" + endpoint]
                record["detach_argv"] = [node, str(cli), "-s=" + name, "detach"]
                (directory / "instructions.md").write_text(worker_instructions(record))
                write_json(directory / "host.json", record)
                write_json(active, record)
                print("Browser ready: " + endpoint, flush=True)
                print("Leave this terminal running. Ctrl-C stops only this helper's browser.", flush=True)
                print("Tell Pi: Read .cache/piccolo/browser-host/active.json and its referenced instructions. "
                      "Retry Case 6 by delegation using the supplied CDP attachment; preserve prior evidence.", flush=True)
                code = process.wait()
                record["browser_exit_code"] = code
                if code:
                    raise RuntimeError("Browser exited unexpectedly; inspect chrome.log")
        except KeyboardInterrupt:
            record["stop_reason"] = "operator_interrupt"
        except Exception as error:
            result = 1
            record["error"] = str(error)
            print("Browser host failed: " + str(error), flush=True)
        finally:
            record.update(status="failed" if result else "stopped", stopped_at=now())
            if process is not None:
                try:
                    stop_owned(process)
                except (OSError, subprocess.SubprocessError) as error:
                    result = 1
                    record.update(status="needs_reconciliation", cleanup_error=str(error))
            write_json(directory / "host.json", record)
            write_json(active, record)
        print("Browser evidence retained at " + str(directory), flush=True)
        return result


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit("Browser host: " + str(error))
