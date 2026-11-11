import importlib.util
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'packages/health/scripts/runtime-profile.py'
spec = importlib.util.spec_from_file_location('runtime_profile_under_test', SOURCE)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def profile(version, methods):
    return {'format': 1, 'version': version, 'platform': 'darwin', 'qualified': False,
            'hashes': {name: 'a' * 64 for name in methods},
            'boundHashes': {name: 'b' * 64 for name in capture.BOUND_METHODS},
            'descriptors': {name: {'kind': 'getter' if name in {'isIdle', 'isStreaming'} else 'method',
                                   'configurable': True} for name in methods},
            'missing': [], 'prototype_extensible': True}


class RuntimeProfileTests(unittest.TestCase):
    def test_modern_pi_versions_require_run_preparation_methods(self):
        for version in ['1.3.0', '1.4.0']:
            self.assertTrue(capture.validate_profile(profile(version, capture.expected_methods(version))))
            self.assertFalse(capture.validate_profile(profile(version, capture.METHODS)))

    def test_legacy_capture_keeps_its_original_method_contract(self):
        self.assertTrue(capture.validate_profile(profile('0.86.1', capture.METHODS)))
        self.assertFalse(capture.validate_profile(profile('0.86.1', capture.MODERN_METHODS)))

    def test_incomplete_or_unusable_modern_capture_cannot_pass(self):
        for change in [lambda p: p['boundHashes'].pop('checkAuth'),
                       lambda p: p['hashes'].pop('_prepareRun'),
                       lambda p: p['descriptors']['_startRun'].update(configurable=False),
                       lambda p: p.update(missing=['bound.checkAuth']),
                       lambda p: p.update(prototype_extensible=False)]:
            value = profile('1.4.0', capture.PI_140_METHODS)
            change(value)
            self.assertFalse(capture.validate_profile(value))

    def test_cleanup_capture_rejects_wrong_types_hashes_and_descriptor_kinds(self):
        for change in [lambda p: p.update(format=True), lambda p: p.update(qualified=True),
                       lambda p: p['hashes'].update(_emitAgentSettled='z' * 64),
                       lambda p: p['boundHashes'].update(checkAuth='a' * 63),
                       lambda p: p['descriptors']['_resolveIdleWaitIfIdle'].update(kind='getter')]:
            value = profile('1.4.0', capture.PI_140_METHODS)
            change(value)
            self.assertFalse(capture.validate_profile(value))


if __name__ == '__main__':
    unittest.main()
