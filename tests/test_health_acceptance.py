"""Qualification must reject incomplete/error parent turns without live model calls."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/acceptance-health-jobs.py'
spec = importlib.util.spec_from_file_location('health_acceptance_under_test', SOURCE)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class ParentCompletionTests(unittest.TestCase):
    def run_fixture(self, reason, settlement):
        with tempfile.TemporaryDirectory(prefix='health-acceptance-') as temporary:
            root = Path(temporary)
            project = root / 'project'
            job = project / '.piccolo/jobs/job-one'
            for directory in [project / '.pi', project / '.cache', job,
                              root / 'state/pi-harness-health/cwd']:
                directory.mkdir(parents=True, exist_ok=True)
            (root / 'fixture.json').write_text(json.dumps({'source_commit': 'fixture', 'gpt_model': 'fixture/model', 'notifications': 'follow_up'}))
            (project / '.pi/settings.json').write_text(json.dumps({'packages': [], 'extensions': []}))
            sent = []

            class Process:
                returncode = None

                def poll(self):
                    return self.returncode

            class FakeRpc:
                def __init__(self, _root, _manifest):
                    self.process = Process()
                    final = {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': reason,
                             'content': [{'type': 'text', 'text': 'REAL-JOB-RECOVERED HEALTH-PROBE-29'}]}}
                    settled = {'type': 'agent_settled'}
                    self.events = ([settled] if settlement == 'before' else []) + [final] + ([settled] if settlement == 'after' else [])
                    (job / 'outcome.json').write_text(json.dumps({'state': 'completed', 'result': {'model': 'fixture/model', 'text': 'HEALTH-PROBE-29'}}))
                    entries = [{'message': {'content': [
                        {'type': 'toolCall', 'name': 'piccolo_submit', 'arguments': {}},
                        {'type': 'toolCall', 'name': 'piccolo_jobs', 'arguments': {'action': 'result', 'id': job.name}},
                    ]}}, {'customType': 'harness-health-parent-start'}]
                    (project / '.cache/jobs-rpc.jsonl').write_text('\n'.join(map(json.dumps, entries)))
                    (root / 'state/pi-harness-health/cwd/runtime.json').write_text(json.dumps({'incidents': [{'component': 'attention', 'disposition': 'resolved'}]}))

                def prompt(self, _text):
                    pass

                def wait(self, predicate, _timeout):
                    if not predicate():
                        raise TimeoutError('Required evidence did not arrive')

                def send(self, command):
                    sent.append(command['type'])

                def close(self):
                    self.process.returncode = 0
                    (project / '.cache/health-shutdown.json').write_text('{}')

            with patch.object(acceptance.jobs, 'Rpc', FakeRpc), patch.object(acceptance.time, 'sleep'), \
                    patch('sys.argv', [str(SOURCE), '--root', str(root)]), contextlib.redirect_stdout(io.StringIO()):
                acceptance.main()
            return json.loads((root / 'health-jobs-acceptance.json').read_text()), sent

    def test_passive_fixture_is_rejected_before_native_launch_or_mutation(self):
        with tempfile.TemporaryDirectory(prefix='health-passive-fixture-') as temporary:
            root = Path(temporary)
            (root / 'fixture.json').write_text(json.dumps({'notifications': 'notify_only'}))
            with patch('sys.argv', [str(SOURCE), '--root', str(root)]):
                with self.assertRaisesRegex(RuntimeError, '--notifications follow_up'):
                    acceptance.main()
            self.assertFalse((root / 'project').exists())
            self.assertFalse((root / 'health-jobs-acceptance.json').exists())

    def test_error_response_cannot_qualify_even_with_expected_text_and_settlement(self):
        receipt, _ = self.run_fixture('error', 'after')
        self.assertEqual(receipt['status'], 'fail')

    def test_final_response_without_settlement_cannot_qualify(self):
        receipt, _ = self.run_fixture('stop', None)
        self.assertEqual(receipt['status'], 'fail')

    def test_settlement_before_final_response_does_not_qualify(self):
        receipt, _ = self.run_fixture('stop', 'before')
        self.assertEqual(receipt['status'], 'fail')

    def test_settled_final_response_qualifies_without_abort(self):
        receipt, sent = self.run_fixture('stop', 'after')
        self.assertEqual(receipt['status'], 'pass')
        self.assertTrue(receipt['checks']['parent_settled'])
        self.assertEqual(sent, ['prompt'])


if __name__ == '__main__':
    unittest.main()
