#!/usr/bin/env python3
"""Pinned compatibility patch: Node DSL worker under a Bun-hosted managed Pi."""
import argparse
import hashlib
import json
from pathlib import Path

ORIGINAL = "95b6873cee5b6d3869c69b4252b20ace06a6fb177a0f16aaa82c5a5947c465cb"
MARKER = "// Piccolo: use Node permission model for the DSL worker, never a Pi launcher."


def patched(source):
    replacements = {
        'serialization: "advanced"': 'serialization: "json"',
        'const child = fork(childFile, [String(RPC_LIMIT_BYTES), config], {':
            'const child = fork(childFile, [String(RPC_LIMIT_BYTES), config], {\n    ' + MARKER + '\n    execPath: process.versions.bun ? "node" : process.execPath,',
        'return process.versions.bun ? filtered : [...filtered, "--max-old-space-size=128", "--permission", `--allow-fs-read=${childDir}`];':
            'return [...(process.versions.bun ? [] : filtered), "--max-old-space-size=128", "--permission", `--allow-fs-read=${childDir}`];',
        '// NOTE: a Bun-compiled pi binary is process.execPath; BUN_BE_BUN makes it run child.cjs instead of the pi CLI.\n    env: process.versions.bun ? { ...process.env, BUN_BE_BUN: "1" } : process.env,':
            'env: process.env,',
        'stdio: ["ignore", "ignore", "ignore", "ipc"]':
            'stdio: ["ignore", "ignore", "inherit", "ipc"]',
    }
    for old, new in replacements.items():
        if source.count(old) != 1:
            raise ValueError("Pinned workflow worker patch anchor changed")
        source = source.replace(old, new)
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    root = args.package.resolve()
    manifest = json.loads((root / "package.json").read_text())
    if (manifest.get("name"), manifest.get("version")) != ("pi-extensible-workflows", "5.14.0"):
        raise ValueError("Requires pi-extensible-workflows 5.14.0")
    target = root / "dist/src/index.js"
    source = target.read_text()
    if MARKER in source:
        # Exact expected patched digest; a marker alone cannot qualify drift.
        if hashlib.sha256(target.read_bytes()).hexdigest() != PATCHED:
            raise ValueError("Patched workflow worker drifted")
        print("Workflow worker patch already applied")
        return
    if hashlib.sha256(target.read_bytes()).hexdigest() != ORIGINAL:
        raise ValueError("Upstream workflow worker changed; review before patching")
    result = patched(source)
    if hashlib.sha256(result.encode()).hexdigest() != PATCHED:
        raise ValueError("Unexpected patch result")
    target.write_text(result)
    print("Patched DSL interpreter only; native Pi model sessions unchanged")


PATCHED = "5414c2036a4f7e889fe77971757748cbf83b1540304b0a281f1d96ce65f2f6ed"
if __name__ == "__main__":
    main()
