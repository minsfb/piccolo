import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('display_acceptance', Path(__file__).resolve().parents[1] / 'scripts/acceptance-display.py')
display = importlib.util.module_from_spec(spec)
spec.loader.exec_module(display)


class DisplayAccountingTests(unittest.TestCase):
    def test_requires_exact_completed_work_before_shutdown(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            messages = [{'role': 'assistant', 'content': [{'type': 'toolCall', 'name': 'piccolo_submit'}]}]
            def record(kind, identity, outcome):
                home = project / '.piccolo' / kind / identity
                home.mkdir(parents=True)
                (home / 'launch.json').write_text('{}')
                if outcome:
                    (home / 'outcome.json').write_text(json.dumps(outcome))
                return home
            record('jobs', 'expected', {'state': 'completed'})
            run = record('runs', 'expected', {'status': 'completed'})
            self.assertTrue(display.work_accounting(project, messages))
            self.assertFalse(display.work_accounting(project, messages * 2))
            (run / 'outcome.json').unlink()
            self.assertFalse(display.work_accounting(project, messages))
            (run / 'outcome.json').write_text('{"status":"cancelled"}')
            self.assertFalse(display.work_accounting(project, messages))
            (run / 'outcome.json').write_text('{"status":"completed"}')
            record('jobs', 'unexpected', None)
            self.assertFalse(display.work_accounting(project, messages))
