#!/usr/bin/env python3
"""Opt-in, byte-pinned Pi 0.85.1 wake bridge. Install only while Pi is stopped.

Use --check to inspect; otherwise --apply or --restore is required. Target is the package
directory containing package.json, not an executable or live session. This
patch affects ONLY imports of the unbundled SDK/dist modules. It does not modify
the npm default bundled CLI or a compiled executable. Restart the
explicitly staged SDK host after installation; do not substitute an unmanaged
CLI for the managed launcher. Original files are retained beside their replacements.
"""
import argparse
import hashlib
import json
from pathlib import Path

PINS = {
    "dist/core/agent-session.js": "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f",
    "dist/core/extensions/runner.js": "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61",
}
MARK = "pi.harness.health.wake.v1"

WRAPPER = '''    // pi.harness.health.wake.v1: reserve preflight before its first await.
    async prompt(text, options) {
        const identity = this.sessionManager.getSessionId();
        const current = healthAdmission.getStore();
        if (this._healthPromptGate && current?.session === this && current?.gate === this._healthPromptGate && current.command) this._healthUnlockPrompt?.();
        if (this._healthPromptGate && current?.session === this && current?.gate === this._healthPromptGate) {
            throw new Error("Cannot start inference reentrantly during prompt preflight. Return from the command or input hook before starting another turn, or use nextTurn delivery.");
        }
        let waited = false;
        while (this._healthPromptGate) {
            waited = true;
            await this._healthPromptGate;
        }
        if (this._healthDisposed || this.sessionManager.getSessionId() !== identity) {
            throw new Error("Session changed before queued prompt could be submitted");
        }
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        this._healthPromptGate = gate;
        const unlock = () => {
            if (this._healthPromptGate === gate) {
                this._healthPromptGate = undefined;
                this._healthUnlockPrompt = undefined;
            }
            release();
        };
        this._healthUnlockPrompt = unlock;
        const abortEpoch = this._healthAbortEpoch;
        const nextTurn = this._pendingNextTurnMessages;
        let started = false;
        const admitted = () => { started = true; unlock(); };
        try {
            // A submitted prompt that raced wake preflight must queue rather
            // than fail the native already-processing check. Preserve explicit
            // steering/follow-up choices. Never read or write editor contents.
            const behavior = options?.streamingBehavior ?? ((waited || this._healthWakeRun) ? "followUp" : undefined);
            return await healthAdmission.run({ session: this, gate }, () => this._healthOriginalPrompt(text, { ...options, streamingBehavior: behavior }, admitted, identity, abortEpoch));
        } catch (error) {
            if (!started && !this._healthDisposed && identity === this.sessionManager.getSessionId() && abortEpoch !== this._healthAbortEpoch && Array.isArray(nextTurn) && Array.isArray(this._pendingNextTurnMessages) && nextTurn !== this._pendingNextTurnMessages) {
                this._pendingNextTurnMessages = [...nextTurn, ...this._pendingNextTurnMessages.filter(message => !nextTurn.includes(message))];
            }
            throw error;
        } finally { unlock(); }
    }
    _healthRequestWake(request) {
        const id = typeof request?.id === "string" ? request.id : "";
        const receipt = status => ({ id, status });
        if (!id || id.length > 200 || typeof request?.content !== "string" || !request.content.trim() || request.content.length > 16000) return receipt("invalid");
        if (this._healthDisposed || request.sessionId !== this.sessionManager.getSessionId()) return receipt("stale");
        if (this._healthWakeIds?.has(id)) return receipt("duplicate");
        if (this._healthPromptGate || this._healthWakeRun || !this.isIdle || this._bashAbortControllers?.size || this._branchSummaryAbortController) return receipt("busy");
        this._healthWakeIds ??= new Set();
        this._healthWakeIds.add(id);
        if (this._healthWakeIds.size > 256) this._healthWakeIds.delete(this._healthWakeIds.values().next().value);
        const run = this.prompt(request.content, { expandPromptTemplates: false, source: "extension" });
        this._healthWakeRun = run;
        run.catch(() => {
            // Receipt only acknowledges submission. Native errors and missing
            // agent_start are observed by the health extension, without logging
            // endpoint credentials or raw auth errors through this bridge.
        }).finally(() => { if (this._healthWakeRun === run) this._healthWakeRun = undefined; });
        return receipt("accepted");
    }
    async _healthOriginalPrompt(text, options, unlock, identity, abortEpoch) {'''


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("Pi source shape differs from qualified compatibility patch")
    return text.replace(before, after, 1)


def patch_session(text):
    text = replace_once(text, 'import { readFileSync } from "node:fs";', 'import { readFileSync } from "node:fs";\nimport { AsyncLocalStorage } from "node:async_hooks";\nconst healthAdmission = new AsyncLocalStorage();')
    text = replace_once(text, "    async prompt(text, options) {", WRAPPER)
    text = replace_once(text, "    async _tryExecuteExtensionCommand(text) {", '''    async _tryExecuteExtensionCommand(text) {
        const current = healthAdmission.getStore();
        if (current?.session === this) current.command = true;
        try { return await this._healthOriginalCommand(text); }
        finally { if (current?.session === this) current.command = false; }
    }
    async _healthOriginalCommand(text) {''')
    text = replace_once(text, "        await this._runAgentPrompt(messages);\n    }", "        const run = this._runAgentPrompt(messages);\n        unlock();\n        await run;\n    }")
    guard = '            if (this._healthDisposed || identity !== this.sessionManager.getSessionId() || abortEpoch !== this._healthAbortEpoch) throw new Error("Session changed or prompt interrupted during preflight");\n'
    text = replace_once(text, '                const handled = await this._tryExecuteExtensionCommand(text);\n                if (handled) {', '                const handled = await this._tryExecuteExtensionCommand(text);\n                if (!handled && (this._healthDisposed || identity !== this.sessionManager.getSessionId() || abortEpoch !== this._healthAbortEpoch)) throw new Error("Session changed or prompt interrupted during preflight");\n                if (handled) {')
    text = replace_once(text, '                if (inputResult.action === "handled") {', guard + '                if (inputResult.action === "handled") {')
    text = replace_once(text, '            if (!hasConfiguredAuth) {', guard + '            if (!hasConfiguredAuth) {')
    text = replace_once(text, '            // Build messages array (custom message if any, then user message)', guard + '            // Build messages array (custom message if any, then user message)')
    text = replace_once(text, "            // Apply extension-modified system prompt, or reset to base", "            if (this._healthDisposed || identity !== this.sessionManager.getSessionId() || abortEpoch !== this._healthAbortEpoch) throw new Error(\"Session changed or prompt interrupted during preflight\");\n            // Apply extension-modified system prompt, or reset to base")
    # Cancellation invalidates the preflight but does not release its admission
    # reservation until the original await settles and pending context has been
    # restored. A subsequent user submission must not overtake that restoration.
    text = replace_once(text, "    async abort() {\n", "    async abort() {\n        this._healthAbortEpoch = (this._healthAbortEpoch ?? 0) + 1;\n        this._healthWakeRun = undefined;\n")
    text = replace_once(text, "    dispose() {\n", "    dispose() {\n        this._healthDisposed = true;\n        this._healthUnlockPrompt?.();\n")
    text = replace_once(text, "    async sendCustomMessage(message, options) {\n", '''    async sendCustomMessage(message, options) {
        const identity = this.sessionManager.getSessionId();
        if (options?.triggerTurn && options?.deliverAs !== "nextTurn") {
            const current = healthAdmission.getStore();
            if (this._healthPromptGate && current?.session === this && current?.gate === this._healthPromptGate && current.command) this._healthUnlockPrompt?.();
            if (this._healthPromptGate && current?.session === this && current?.gate === this._healthPromptGate) {
                throw new Error("Cannot start inference reentrantly during prompt preflight. Return from the command or input hook before starting another turn, or use nextTurn delivery.");
            }
            while (this._healthPromptGate) await this._healthPromptGate;
            if (this._healthDisposed || identity !== this.sessionManager.getSessionId()) throw new Error("Session changed before custom message submission");
        }
''')
    text = replace_once(text, "        runner.bindCore({\n", '''        runner.healthRequestWake = request => this._healthRequestWake(request);
        runner.bindCore({
''')
    return text


def patch_runner(text):
    return replace_once(text, "        const getScopedModels = this.getScopedModels;\n        return {\n", '''        const getScopedModels = this.getScopedModels;
        return {
            [Symbol.for("pi.harness.health.wake.v1")]: request => {
                runner.assertActive();
                return runner.healthRequestWake?.(request) ?? { id: request?.id, status: "unsupported" };
            },
''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    root = args.package.resolve()
    manifest = json.loads((root / "package.json").read_text())
    if manifest.get("name") != "@earendil-works/pi-coding-agent" or manifest.get("version") != "0.85.1":
        raise SystemExit("Unsupported Pi package/version; no files changed")
    staged = []
    for name, pin in PINS.items():
        path = root / name
        raw = path.read_bytes()
        backup = path.with_name(path.name + ".health-wake-original")
        original = backup.read_bytes() if backup.exists() else raw
        if hashlib.sha256(original).hexdigest() != pin:
            raise SystemExit(f"Unqualified source bytes: {name}; no files changed")
        patched = (patch_session if name.endswith("agent-session.js") else patch_runner)(original.decode()).encode()
        if raw not in (original, patched):
            raise SystemExit(f"Source drift: {name}; no files changed")
        staged.append((path, backup, original, patched, raw == patched))
    if args.apply or args.restore:
        # Validate the entire patch before any write. Backups make interruption
        # recoverable; rerunning safely finishes a partially installed pair.
        for path, backup, original, patched, installed in staged:
            if (args.apply and installed) or (args.restore and not installed):
                continue
            if not backup.exists():
                with backup.open("xb") as out:
                    out.write(original)
            temporary = path.with_name(path.name + ".health-wake-new")
            with temporary.open("xb") as out:
                out.write(original if args.restore else patched)
            temporary.chmod(path.stat().st_mode)
            temporary.replace(path)
    print(json.dumps({"version": "0.85.1", "bridge": MARK, "scope": "sdk-unbundled-only", "managed_parent_supported": False, "status": "restored" if args.restore else "installed" if args.apply or all(row[4] for row in staged) else "compatible", "restart_required": bool(args.apply or args.restore)}))


if __name__ == "__main__":
    main()
