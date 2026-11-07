#!/usr/bin/env python3
"""Apply/revert the exact experimental pi-subagents 0.68.0 Bun transport fix.

Run only against an intentionally selected, stopped project installation. This
does not install packages or alter managed Pi. Native Pi remove/reinstall removes
the patch. See docs/setup-v0.1.md. Qualification is still required on each host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import tempfile

ORIGINAL = "834e2568be5221511c4e1d416b49d32cb8140ed7ed540142c49bb79e024e47dd"
PATCHED = "3d82505a73bda9df914b61cbfe5a28622e5a5a2cc161b46f0d543be602927cc7"
CALL = b"installRunnerHttpDispatcher({ agentDir: getAgentDir(), cwd: process.cwd() });"


def transform(data, revert=False):
    before, after = (PATCHED, ORIGINAL) if revert else (ORIGINAL, PATCHED)
    digest = hashlib.sha256(data).hexdigest()
    if digest == after:
        return data, False
    if digest != before:
        raise ValueError("Unrecognized bootstrap source; refusing to modify it")
    old, new = (b"if (!process.versions.bun) " + CALL, CALL) if revert else (CALL, b"if (!process.versions.bun) " + CALL)
    updated = data.replace(old, new, 1)
    if hashlib.sha256(updated).hexdigest() != after:
        raise ValueError("Unexpected patch result")
    return updated, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--revert", action="store_true")
    args = parser.parse_args()
    root = args.package_root.resolve(strict=True)
    manifest = json.loads((root/"package.json").read_text())
    if manifest.get("name") != "pi-subagents" or manifest.get("version") != "0.68.0":
        parser.error("Requires the exact pi-subagents 0.68.0 installation")
    path = root/"src/runs/background/binary-bootstrap.ts"
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        parser.error("Bootstrap must be a regular file within the package")
    source = path.read_bytes()
    try:
        updated, changed = transform(source, args.revert)
    except ValueError as error:
        parser.error(str(error))
    if changed:
        # Preserve file mode and replace only after the full candidate is written.
        fd, temporary = tempfile.mkstemp(prefix=".piccolo-compat-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, path.stat().st_mode & 0o777)
            if path.read_bytes() != source:
                raise RuntimeError("Bootstrap changed during patching")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(json.dumps({"version": "0.68.0", "action": "revert" if args.revert else "apply",
                      "changed": changed, "sha256": hashlib.sha256(updated).hexdigest()}))


if __name__ == "__main__":
    main()
