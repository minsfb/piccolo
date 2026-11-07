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
            self.assertNotIn("qualification_finished", result.stdout)

    def test_opt_flag_refuses_before_setup(self):
        self.run_optimized(["-O"], dict(os.environ))

    def test_optimization_environment_refuses_before_setup(self):
        self.run_optimized([], {**os.environ, "PYTHONOPTIMIZE": "1"})

    def test_normal_python_help_remains_available(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "qualify-durable-pipelines.py"
        environment = dict(os.environ)
        environment.pop("PYTHONOPTIMIZE", None)
        result = subprocess.run([sys.executable, str(script), "--help"], env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--scenario", result.stdout)


if __name__ == "__main__":
    unittest.main()
