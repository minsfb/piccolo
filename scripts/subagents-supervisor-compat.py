#!/usr/bin/env python3
"""Apply/revert the exact pi-subagents 0.79.2 opt-in supervisor continuation bridge.

Run only against an intentionally selected, stopped project installation. This
does not install packages or alter managed Pi. Native Pi remove/reinstall removes
the patch.  Qualification is still required on each host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import tempfile

PATCHES = json.loads(Path(__file__).with_name("subagents-supervisor-patch.json").read_text())


def transform(data, spec, revert=False):
    before, after = (spec["patched"], spec["original"]) if revert else (spec["original"], spec["patched"])
    digest = hashlib.sha256(data).hexdigest()
    if digest == after:
        return data, False
    if digest != before:
        raise ValueError("Unrecognized supervisor bridge source; refusing to modify it")
    updated = data
    for old, new in spec["edits"]:
        if revert:
            old, new = new, old
        if updated.count(old.encode()) != 1:
            raise ValueError("Unexpected patch anchor")
        updated = updated.replace(old.encode(), new.encode(), 1)
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
    if manifest.get("name") != "pi-subagents" or manifest.get("version") != "0.79.2":
        parser.error("Requires the exact pi-subagents 0.79.2 installation")
    candidates = []
    # Validate every file before modifying any; partial interrupted applications
    # remain idempotent, but unknown source always fails before further writes.
    for relative, spec in PATCHES.items():
        path = root/relative
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            parser.error("Bridge must be a regular file within the package")
        source = path.read_bytes()
        try:
            updated, changed = transform(source, spec, args.revert)
        except ValueError as error:
            parser.error(str(error))
        candidates.append((path, source, updated, changed))
    receipts = []
    for path, source, updated, changed in candidates:
        if changed:
            fd, temporary = tempfile.mkstemp(prefix=".piccolo-compat-", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(updated)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, path.stat().st_mode & 0o777)
                if path.read_bytes() != source:
                    raise RuntimeError("Bridge changed during patching")
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        receipts.append({"file": str(path.relative_to(root)), "changed": changed,
                         "sha256": hashlib.sha256(updated).hexdigest()})
    print(json.dumps({"version": "0.79.2", "action": "revert" if args.revert else "apply", "files": receipts}))


if __name__ == "__main__":
    main()
