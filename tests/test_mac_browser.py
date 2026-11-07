"""Offline browser-host identity and launch checks; no browser/network/model calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mac_browser", Path(__file__).parents[1] / "scripts/mac-browser.py")
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class BrowserHostTests(unittest.TestCase):
    def test_reject_invalid_port_and_browser_identity_file(self):
        self.assertEqual(browser.parse_endpoint("42341\n/devtools/browser/abcd-1234\n"),
                         (42341, "/devtools/browser/abcd-1234"))
        for value in ("0\n/devtools/browser/id", "65536\n/devtools/browser/id", "9222\nhttps://elsewhere",
                      "9222\n/devtools/browser/id?token=value", "9222\n/devtools/browser/id\nextra"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                browser.parse_endpoint(value)

    def test_version_response_must_match_owned_profile_endpoint(self):
        valid = {"Browser": "Chrome/154.0.8037.0", "webSocketDebuggerUrl": "ws://127.0.0.1:42341/devtools/browser/id"}
        browser.verify_version(valid, 42341, "/devtools/browser/id")
        for url in ("ws://remote.invalid:42341/devtools/browser/id", "ws://127.0.0.1:9222/devtools/browser/id",
                    "ws://127.0.0.1:42341/devtools/browser/other", "ws://user@127.0.0.1:42341/devtools/browser/id"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                browser.verify_version({**valid, "webSocketDebuggerUrl": url}, 42341, "/devtools/browser/id")

    def test_listener_must_belong_to_pid_and_be_loopback(self):
        with patch.object(browser.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "p123\nf21\nn127.0.0.1:42341\n")) as run:
            browser.verify_listener("lsof", 123, 42341)
            self.assertEqual(run.call_args.args[0], ["lsof", "-nP", "-a", "-p", "123", "-iTCP:42341", "-sTCP:LISTEN", "-Fn"])
        for output in ("p123\nf21\nn*:42341\n", "p123\nf21\nn10.0.0.2:42341\n", ""):
            with patch.object(browser.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)), self.assertRaises(ValueError):
                browser.verify_listener("lsof", 123, 42341)

    def test_launcher_preserves_sandbox_and_separates_space_containing_paths(self):
        command = browser.browser_command(Path("/kit/Chrome for Testing"), Path("/kit/fresh profile"))
        self.assertEqual(command[0], "/kit/Chrome for Testing")
        self.assertIn("--user-data-dir=/kit/fresh profile", command)
        self.assertIn("--remote-debugging-port=0", command)
        self.assertIn("--remote-debugging-address=127.0.0.1", command)
        self.assertFalse(any("no-sandbox" in arg or "disable-setuid-sandbox" in arg for arg in command))

    def test_atomic_receipt_does_not_follow_existing_target_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unrelated = root / "unrelated.json"
            unrelated.write_text("unchanged")
            target = root / "active.json"
            target.symlink_to(unrelated)
            browser.write_json(target, {"status": "ready"})
            self.assertEqual(unrelated.read_text(), "unchanged")
            self.assertFalse(target.is_symlink())
            self.assertEqual(json.loads(target.read_text()), {"status": "ready"})


if __name__ == "__main__":
    unittest.main()
