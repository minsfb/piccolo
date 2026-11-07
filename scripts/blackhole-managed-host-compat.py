#!/usr/bin/env python3
"""Apply/revert the exact experimental pi-blackhole 0.5.5 bundled-host discovery fix.

Run only against an intentionally selected, stopped project installation. This
does not install packages or alter managed Pi. Native Pi remove/reinstall removes
the patch. See docs/compaction.md. Qualification is still required on each host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import tempfile

ORIGINAL = '9102121c2983c77ee3759c189f6f014db48cdb8c89f020156989f218b576ea99'
PATCHED = '4b47053154184cf4a7e264d09304f92f7f17d25a54fc2aa3aca3947d475f2a58'
PAIRS = [(b'import { installHostInlineCompactionAdapter }', b'import { installHostInlineCompactionAdapter, installInlineCompactionAdapter }'), (b'  const inlineCompactionAdapterStatus = await installHostInlineCompactionAdapter();', b'  const discoveredAdapter = await installHostInlineCompactionAdapter();\n  const inlineCompactionAdapterStatus = discoveredAdapter.supported\n    ? discoveredAdapter\n    : installInlineCompactionAdapter();')]

def transform(data, revert=False):
    before, after = (PATCHED, ORIGINAL) if revert else (ORIGINAL, PATCHED)
    digest = hashlib.sha256(data).hexdigest()
    if digest == after:
        return data, False
    if digest != before:
        raise ValueError("Unrecognized entrypoint source; refusing to modify it")
    updated = data
    for old, new in PAIRS:
        updated = updated.replace(new, old, 1) if revert else updated.replace(old, new, 1)
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
    if manifest.get("name") != "pi-blackhole" or manifest.get("version") != "0.5.5":
        parser.error("Requires the exact pi-blackhole 0.5.5 installation")
    path = root/"index.ts"
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        parser.error("Entrypoint must be a regular file within the package")
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
                raise RuntimeError("Entrypoint changed during patching")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(json.dumps({"version": "0.5.5", "action": "revert" if args.revert else "apply",
                      "changed": changed, "sha256": hashlib.sha256(updated).hexdigest()}))


if __name__ == "__main__":
    main()
