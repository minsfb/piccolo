import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class QualificationInterpreterTests(unittest.TestCase):
    def run_optimized(self, flag, environment):
        source = Path(__file__).resolve().parents[1]
        script = source / "scripts" / "qualify-durable-pipelines.py"
        with tempfile.TemporaryDirectory(prefix="piccolo-opt-refusal-") as directory:
            fixture = Path(directory) / "must-not-be-created"
            result = subprocess.run([sys.executable, *flag, str(script), "--source", str(source), "--root", str(fixture), "--node", sys.executable, "--", sys.executable],
                                    env=environment, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Optimized Python is unsupported", result.stderr)
            self.assertFalse(fixture.exists(), "Refusal must precede fixture and process setup")
            self.assertEqual(result.stdout, "", "Refusal must not emit successful or partial evidence")

    def test_opt_flag_refuses_before_setup(self):
        self.run_optimized(["-O"], dict(os.environ))
        self.run_optimized(["-OO"], dict(os.environ))

    def test_optimization_environment_refuses_before_setup(self):
        for value in ("1", "2", "7", "enabled"):
            with self.subTest(value=value):
                self.run_optimized([], {**os.environ, "PYTHONOPTIMIZE": value})

    def test_normal_python_help_remains_available(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "qualify-durable-pipelines.py"
        environment = dict(os.environ)
        environment["PYTHONOPTIMIZE"] = "0"
        result = subprocess.run([sys.executable, str(script), "--help"], env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--scenario", result.stdout)

    def test_dependency_worktree_preparation_preserves_the_frozen_fixture(self):
        source = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("pipeline_qualification", source / "scripts" / "qualify-durable-pipelines.py")
        qualification = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(qualification)
        with tempfile.TemporaryDirectory(prefix="piccolo-fixture-source-") as directory:
            root, _, _, _, base = qualification.prepare_fixture(Path(directory) / "fixture")
            # Exercise the same default area preparation used by a dependency
            # join. It must not change any already frozen source input.
            subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", """
import { selectWorktreePath } from './src/worktree-placement.ts';
import { preflightWorktree } from './src/worktree-preflight.ts';
const root = process.argv[1];
const destination = selectWorktreePath(root, 'dependency-integration');
preflightWorktree(root, destination, 'fixture-join');
""", str(root)], cwd=source, check=True, capture_output=True, text=True, timeout=10)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
            self.assertEqual(git("rev-parse", "HEAD"), base)
            self.assertEqual(git("status", "--porcelain", "--untracked-files=all"), "")
            self.assertTrue((root / ".worktrees").is_dir())


if __name__ == "__main__":
    unittest.main()
