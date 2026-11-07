#!/usr/bin/env python3
"""Inspect or open an evidence file in an explicitly selected Mac editor.

This records launch evidence, never a human UI attestation. Does not register
handlers, install applications, modify Pi configuration or change manual.json.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import subprocess
from urllib.parse import quote

EDITORS = {
    "vscode": "Visual Studio Code.app",
    "cursor": "Cursor.app",
}


def inspect(file, editor, applications=Path("/Applications")):
    file = file.resolve(strict=True)
    if not file.is_file():
        raise ValueError("Select a regular evidence file")
    app = applications / EDITORS[editor]
    plist = app / "Contents/Info.plist"
    info = plistlib.loads(plist.read_bytes()) if plist.is_file() else {}
    schemes = [scheme for item in info.get("CFBundleURLTypes", [])
               for scheme in item.get("CFBundleURLSchemes", [])]
    return {"file": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "editor": editor, "application": str(app),
            "declares_scheme": editor in schemes,
            "url": f"{editor}://file{quote(str(file), safe='/')}",
            "status": "available" if editor in schemes else "blocked",
            "ui_observation": "pending",
            "note": "A bundle declaration or successful open is not proof the editor displayed the exact file."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--editor", choices=EDITORS, required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="New owned evidence directory")
    parser.add_argument("--open", action="store_true", help="Request the explicit editor to open its file URL")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("Run on macOS")
    value = inspect(args.file, args.editor)
    args.output_dir.mkdir(mode=0o700)  # Refuse to overwrite earlier evidence.
    if args.open and value["declares_scheme"]:
        argv = ["open", "-a", value["application"], value["url"]]
        value["argv"] = argv
        with (args.output_dir / "open.log").open("x") as log:
            try:
                result = subprocess.run(argv, stdout=log, stderr=log, timeout=30)
                value["exit_code"] = result.returncode
                value["status"] = "launch_requested" if result.returncode == 0 else "blocked"
            except subprocess.TimeoutExpired:
                value["status"] = "blocked"
                value["error"] = "open timed out; application state needs inspection"
    (args.output_dir / "receipt.json").write_text(json.dumps(value, indent=2) + "\n")
    print(json.dumps(value, indent=2))
    return 1 if value["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
