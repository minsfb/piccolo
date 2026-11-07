"""Editor selection and URI attribution without launching applications."""
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("navigation", Path(__file__).parents[1] / "scripts/mac-navigation.py")
navigation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(navigation)


class NavigationTests(unittest.TestCase):
    def test_selected_editor_and_exact_file_uri(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / "space # %?.png"
            file.write_bytes(b"image fixture")
            plist = root / "Visual Studio Code.app/Contents/Info.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"CFBundleURLTypes": [{"CFBundleURLSchemes": ["vscode"]}]}))
            value = navigation.inspect(file, "vscode", root)
            self.assertEqual(value["status"], "available")
            self.assertTrue(value["url"].startswith("vscode://file/"))
            self.assertTrue(value["url"].endswith("space%20%23%20%25%3F.png"))
            self.assertEqual(value["ui_observation"], "pending")
            self.assertEqual(navigation.inspect(file, "cursor", root)["status"], "blocked")

    def test_wrong_bundle_scheme_does_not_count_as_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / "evidence.txt"
            file.write_text("fixture")
            plist = root / "Cursor.app/Contents/Info.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"CFBundleURLTypes": [{"CFBundleURLSchemes": ["other"]}]}))
            self.assertEqual(navigation.inspect(file, "cursor", root)["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
