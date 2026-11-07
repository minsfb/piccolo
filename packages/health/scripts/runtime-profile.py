#!/usr/bin/env python3
"""Capture a managed Pi runtime fingerprint without inference or installed-file changes.

Run once from a normal terminal. Creates a new private evidence root and an
isolated Pi agent directory. Capturing a profile does NOT qualify safe wake.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time


METHODS = (
    "prompt", "sendCustomMessage", "_runAgentPrompt", "abort", "dispose",
    "_bindExtensionCore", "isIdle", "isStreaming",
    "_checkCompaction", "_tryExecuteExtensionCommand",
)
MODERN_METHODS = tuple(name for name in METHODS if name != "_runAgentPrompt") + ("_startRun", "_prepareRun", "_normalizePromptImages")
BOUND_METHODS = ("emitInput", "emitBeforeAgentStart", "checkAuth")
CLEANUP_METHODS = MODERN_METHODS + ("_emitAgentSettled", "_resolveIdleWaitIfIdle")

def expected_methods(version):
    return CLEANUP_METHODS if version == "1.4.0" else MODERN_METHODS if version == "1.3.0" else METHODS


PROBE = r'''import fs from "node:fs";
import { createHash } from "node:crypto";
import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
const legacy = %METHODS%;
const modern = [...legacy.filter(name => name !== "_runAgentPrompt"), "_startRun", "_prepareRun", "_normalizePromptImages"];
const methods = VERSION === "1.4.0" ? [...modern, "_emitAgentSettled", "_resolveIdleWaitIfIdle"] : VERSION === "1.3.0" ? modern : legacy;
const hash = fn => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value, null, 2) + "\n", {flag:"wx",mode:0o600});
export default function runtimeProfile(pi) {
  const prototype = AgentSession.prototype;
  const binding = Object.getOwnPropertyDescriptor(prototype, "_bindExtensionCore");
  const boundHashes = {};
  const restore = () => {
    if (binding && Object.getOwnPropertyDescriptor(prototype, "_bindExtensionCore")?.value === captureBinding)
      Object.defineProperty(prototype, "_bindExtensionCore", binding);
  };
  function captureBinding(...args) {
    // One observational interception in this isolated probe process; preserve
    // the original receiver/arguments and restore before invoking native code.
    restore();
    const runner = args[0];
    const functions = {emitInput: runner?.emitInput, emitBeforeAgentStart: runner?.emitBeforeAgentStart,
      checkAuth: this._modelRuntime?.checkAuth};
    for (const [name, fn] of Object.entries(functions)) if (typeof fn === "function") boundHashes[name] = hash(fn);
    return binding.value.apply(this, args);
  }
  if (typeof binding?.value === "function" && binding.configurable)
    Object.defineProperty(prototype, "_bindExtensionCore", {...binding, value: captureBinding});
  pi.on("session_shutdown", () => { restore(); write("shutdown.json", {shutdown:true}); });
  pi.on("before_agent_start", () => { throw new Error("Runtime fingerprint probe prohibits inference"); });
  pi.on("agent_start", (_event, ctx) => {
    if (!fs.existsSync("inference-observed.json")) write("inference-observed.json", {unexpected_agent_start:true});
    ctx.abort(); ctx.shutdown();
  });
  pi.registerCommand("health-runtime-profile", {description:"Capture this owned runtime fingerprint and exit", handler: async (_args, ctx) => {
    restore();
    const hashes = {}, descriptors = {}, missing = [];
    for (const name of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, name);
      const fn = descriptor?.value ?? descriptor?.get;
      descriptors[name] = {kind: descriptor?.get ? "getter" : "method", configurable: descriptor?.configurable === true};
      if (typeof fn !== "function") missing.push(name);
      else hashes[name] = hash(fn);
    }
    for (const name of ["emitInput", "emitBeforeAgentStart", "checkAuth"]) if (!boundHashes[name]) missing.push(`bound.${name}`);
    const version = typeof VERSION === "string" && /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/.test(VERSION) ? VERSION : null;
    write("runtime-profile.json", {format:1,version,platform:process.platform,hashes,boundHashes,descriptors,missing,
      prototype_extensible:Object.isExtensible(AgentSession.prototype),qualified:false});
    ctx.shutdown();
  }});
}
'''


class StreamSummary:
    """Drain output without persisting raw output, headers, paths or error text."""

    def __init__(self):
        self.digest = hashlib.sha256()
        self.bytes = 0
        self.sandbox_denied = False
        self.agent_start = False

    def drain(self, pipe):
        carry = b""
        try:
            while True:
                data = pipe.read(4096)
                if not data:
                    break
                self.digest.update(data)
                self.bytes += len(data)
                scan = carry + data
                if b"sandbox_apply" in scan or b"sandbox-exec:" in scan:
                    self.sandbox_denied = True
                if re.search(rb'"type"\s*:\s*"agent_start"', scan):
                    self.agent_start = True
                carry = scan[-256:]
        finally:
            pipe.close()

    def receipt(self):
        return {"bytes": self.bytes, "sha256": self.digest.hexdigest(),
                "sandbox_startup_denied": self.sandbox_denied,
                "agent_start_observed": self.agent_start}


def read_bounded(file):
    if not file.is_file() or file.is_symlink() or file.stat().st_size > 16384:
        return None
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return None


def validate_profile(profile):
    if not isinstance(profile, dict) or profile.get("format") != 1 or profile.get("qualified") is not False:
        return False
    if not isinstance(profile.get("version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?", profile["version"]):
        return False
    if profile.get("platform") not in {"darwin", "linux", "win32", "freebsd", "openbsd", "aix", "sunos", "android"}:
        return False
    hashes, descriptors = profile.get("hashes"), profile.get("descriptors")
    if not isinstance(hashes, dict) or set(hashes) != set(expected_methods(profile["version"])) or not isinstance(descriptors, dict) or set(descriptors) != set(expected_methods(profile["version"])):
        return False
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in hashes.values()):
        return False
    bound = profile.get("boundHashes")
    if not isinstance(bound, dict) or set(bound) != set(BOUND_METHODS):
        return False
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in bound.values()):
        return False
    for name, descriptor in descriptors.items():
        if not isinstance(descriptor, dict) or descriptor != {
            "kind": "getter" if name in {"isIdle", "isStreaming"} else "method", "configurable": True,
        }:
            return False
    return profile.get("missing") == [] and profile.get("prototype_extensible") is True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="New evidence directory; existing roots are rejected")
    parser.add_argument("--pi", default="pi", help="Normal managed Pi executable, without additional arguments")
    parser.add_argument("--timeout", type=int, default=45, help="Startup/shutdown deadline in seconds (5–120)")
    args = parser.parse_args()
    if not 5 <= args.timeout <= 120:
        parser.error("--timeout must be between 5 and 120 seconds")
    root = args.root.expanduser().resolve()
    if root.exists():
        parser.error("--root must not exist; choose a new evidence directory")
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    project = root / "project"
    for directory in [project / ".pi", root / "agent", root / "config", root / "state"]:
        directory.mkdir(parents=True, mode=0o700)
    probe = root / "probe.ts"
    probe.write_text(PROBE.replace("%METHODS%", json.dumps(METHODS)))
    (project / ".pi/settings.json").write_text(json.dumps({"packages": [], "extensions": [str(probe)]}) + "\n")
    (project / "AGENTS.md").write_text("Isolated runtime fingerprint probe. No project tasks, model inference, tools, or file edits by an agent.\n")
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"),
               XDG_CONFIG_HOME=str(root / "config"), XDG_STATE_HOME=str(root / "state"))
    argv = [args.pi, "--approve", "--mode", "json", "--session", str(root / "session.jsonl"),
            "-p", "/health-runtime-profile"]
    streams = [StreamSummary(), StreamSummary()]
    threads = []
    proc = None
    interrupted = False
    forced_shutdown = False
    launch_failed = False
    started = time.monotonic()
    try:
        proc = subprocess.Popen(argv, cwd=project, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        for summary, pipe in zip(streams, [proc.stdout, proc.stderr]):
            thread = threading.Thread(target=summary.drain, args=(pipe,), daemon=True)
            thread.start()
            threads.append(thread)
        # This fixed native extension command runs after startup. It is not a
        # model prompt. Shutting down inside session_start can precede RPC
        # readiness and leave the input loop alive, so capture through the
        # established print-mode command path instead.
        proc.wait(timeout=args.timeout)
    except KeyboardInterrupt:
        interrupted = True
    except subprocess.TimeoutExpired:
        forced_shutdown = True
    except OSError:
        launch_failed = True
    finally:
        if proc is not None:
            if proc.poll() is None:
                forced_shutdown = True
                # Only the process group created for this bounded probe is signaled.
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=2)
    profile = read_bounded(project / "runtime-profile.json")
    shutdown = read_bounded(project / "shutdown.json")
    checks = {
        "profile_complete": validate_profile(profile),
        "native_shutdown_hook": shutdown == {"shutdown": True},
        "clean_exit": proc is not None and proc.returncode == 0 and not forced_shutdown,
        "no_inference_observed": not (project / "inference-observed.json").exists() and not any(s.agent_start for s in streams),
        "no_interruption": not interrupted,
        "streams_closed": not any(thread.is_alive() for thread in threads),
        "launched": not launch_failed,
    }
    receipt = {
        "status": "captured" if all(checks.values()) else "incomplete",
        "checks": checks, "exit_code": proc.returncode if proc else None,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "root": str(root), "profile": str(project / "runtime-profile.json"),
        "version": profile.get("version") if isinstance(profile, dict) and validate_profile(profile) else None,
        "platform": profile.get("platform") if isinstance(profile, dict) and validate_profile(profile) else None,
        "streams": {"stdout": streams[0].receipt(), "stderr": streams[1].receipt()},
        "release_qualified": False,
        "scope": "Runtime fingerprints and clean shutdown only. No model inference, wake qualification, or production profile changes.",
    }
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["status"] == "captured" else 1


if __name__ == "__main__":
    raise SystemExit(main())
