#!/usr/bin/env python3
"""Native TUI display acceptance in an already prepared session-jobs fixture.

Runs ordinary managed Pi with an owned PTY; preserves its normal sandbox.
One real SDK child and two parent turns, no project/services/publication work.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import termios
import time


def work_accounting(project, messages, expected_job=None):
    """Verify the prescribed work settled before shutdown can cancel anything."""
    submits = [p for m in messages if m.get('role') == 'assistant'
               for p in m.get('content', [])
               if p.get('type') == 'toolCall' and p.get('name') == 'piccolo_submit']
    launches = list((project / '.piccolo/jobs').glob('*/launch.json'))
    runs = list((project / '.piccolo/runs').glob('*/launch.json'))
    def completed(paths, field):
        return all((p.parent / 'outcome.json').is_file() and
                   json.loads((p.parent / 'outcome.json').read_text()).get(field) == 'completed'
                   for p in paths)
    if expected_job is not None and {p.parent.name for p in launches} != {expected_job}:
        return False
    return len(submits) == len(launches) == len(runs) == 1 and completed(launches, 'state') and completed(runs, 'status')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    project = root / 'project'
    manifest = json.loads((root / 'fixture.json').read_text())
    if manifest['notifications'] != 'notify_only':
        raise RuntimeError('Prepare with --notifications notify_only')
    if (root / 'display.raw').exists():
        raise RuntimeError('Preserve this attempt and prepare a fresh root')
    spec = importlib.util.spec_from_file_location('jobs', root / 'source/scripts/acceptance-session-jobs.py')
    jobs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(jobs)
    env = jobs.environment(root)
    # Exercise the actual setup seeding routine, without installation/global state.
    subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e',
                    'import {applyQuietDefaults} from "./source/src/setup.ts"; applyQuietDefaults(process.env.PI_CODING_AGENT_DIR);'],
                   cwd=root, env=env, check=True, capture_output=True)
    defaults = json.loads((root / 'agent/settings.json').read_text())
    settings = json.loads((project / '.pi/settings.json').read_text())
    settings['packages'].append(str(root / 'source/packages/health'))
    probe = root / 'display-probe.ts'
    probe.write_text('''import fs from "node:fs";
export default function(pi) {
 pi.registerCommand("acceptance-exit",{handler:async(_a,c)=>c.shutdown()});
 pi.on("session_start",()=>fs.writeFileSync(".cache/display-ready.json","{}"));
 pi.on("agent_end",(_e,c)=>fs.appendFileSync(".cache/display-state.jsonl",JSON.stringify({expanded:c.ui.getToolsExpanded()})+"\\n"));
 pi.on("session_shutdown",()=>fs.writeFileSync(".cache/display-shutdown.json","{}"));
}''')
    settings['extensions'].append(str(probe))
    (project / '.pi/settings.json').write_text(json.dumps(settings, indent=2) + '\n')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    env.update(TERM='xterm-256color', COLUMNS='120', LINES='40')
    argv = jobs.command(root, manifest, 'display-session.jsonl') + ['--model', manifest['gpt_model'], '--thinking', 'medium']
    process = subprocess.Popen(argv, cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    raw = (root / 'display.raw').open('xb')
    checks = {'native_quiet_defaults': all(defaults.get(k) is True for k in ['hideThinkingBlock', 'quietStartup', 'collapseChangelog'])}
    forced = False
    session = project / '.cache/display-session.jsonl'

    def pump():
        if select.select([master], [], [], .2)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            raw.write(data)
            raw.flush()
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')

    def wait(predicate, seconds=120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            if predicate():
                return
            if process.poll() is not None:
                raise RuntimeError('Pi exited before assertion')
        raise TimeoutError('Bounded display check expired')

    def settle():
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            pump()

    def messages():
        if not session.exists():
            return []
        result = []
        for line in session.read_text().splitlines():
            try:
                result.append(json.loads(line).get('message', {}))
            except ValueError:
                pass
        return result

    def final(marker):
        return any(m.get('role') == 'assistant' and m.get('stopReason') == 'stop' and
                   any(p.get('type') == 'text' and marker in p.get('text', '') for p in m.get('content', [])) for m in messages())

    def submit(text):
        os.write(master, b'\x1b[200~' + text.encode() + b'\x1b[201~\r')

    def output(offset=0):
        data = (root / 'display.raw').read_bytes()[offset:].decode('utf-8', 'replace')
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', data)

    try:
        wait(lambda: (project / '.cache/display-ready.json').exists(), 60)
        settle()
        checks['quiet_startup'] = '[Extensions]' not in output() and "What's New" not in output()
        submit('Call piccolo_catalog once, then harness_health with action status once. Use piccolo_submit exactly once with kind delegate and arguments {"type":"probe","task":"Reply with 35 numbered lines, each containing SYNTHETIC-DETAIL. Do not use tools or modify files."}. Return immediately with DISPLAY-SUBMITTED and the job ID. Do not poll, wait or stop the child. Keep commentary to one sentence.')
        wait(lambda: final('DISPLAY-SUBMITTED'))
        homes = list((project / '.piccolo/jobs').glob('*/launch.json'))
        assert len(homes) == 1
        home = homes[0].parent
        wait(lambda: (home / 'outcome.json').exists())
        assert json.loads((home / 'outcome.json').read_text())['state'] == 'completed'
        settle()
        checks['compact_catalog'] = 'agent types' in output()
        checks['compact_health'] = 'Health active' in output()
        checks['compact_submit'] = 'queued' in output() and 'review not_ready' in output()
        start = (root / 'display.raw').stat().st_size
        submit('Inspect piccolo_jobs result for job ' + home.name + ' and harness_health status. Do not repeat the result or JSON in your answer. Reply exactly DISPLAY-INSPECTED. Do not submit another job.')
        wait(lambda: final('DISPLAY-INSPECTED'))
        settle()
        checks['collapsed_large_result'] = 'SYNTHETIC-DETAIL' not in output(start) and '"outcome_revision"' not in output(start)
        retained = [m for m in messages() if m.get('role') == 'toolResult' and m.get('toolName') == 'piccolo_jobs']
        checks['model_result_retained'] = any('SYNTHETIC-DETAIL' in json.dumps(m.get('details')) for m in retained)
        before = (root / 'display.raw').stat().st_size
        os.write(master, b'\x0f')  # native Ctrl+O
        wait(lambda: '"outcome_revision"' in output(before) and 'SYNTHETIC-DETAIL' in output(before), 10)
        checks['native_ctrl_o_expands'] = True
        os.write(master, b'\x0f')
        settle()
        # Native Ctrl+T owns thinking visibility and persists it through Pi.
        os.write(master, b'\x14')
        wait(lambda: json.loads((root / 'agent/settings.json').read_text()).get('hideThinkingBlock') is False, 10)
        os.write(master, b'\x14')
        wait(lambda: json.loads((root / 'agent/settings.json').read_text()).get('hideThinkingBlock') is True, 10)
        checks['native_ctrl_t_toggle'] = True
        checks['exact_settled_work_before_shutdown'] = work_accounting(project, messages(), home.name)
        checks['no_leases_before_shutdown'] = not list((root / 'state/piccolo/pool').glob('*/slot-*.json'))
        submit('/acceptance-exit')
        wait(lambda: process.poll() is not None, 30)
    except (Exception, KeyboardInterrupt) as error:
        checks['error'] = type(error).__name__
    finally:
        try:
            if process.poll() is None:
                forced = True
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        except (Exception, KeyboardInterrupt) as error:
            checks['cleanup_error'] = type(error).__name__
        for close in [raw.close, lambda: os.close(master)]:
            try:
                close()
            except (Exception, KeyboardInterrupt) as error:
                checks['stream_cleanup_error'] = type(error).__name__
    checks['native_shutdown'] = not forced and process.returncode == 0 and (project / '.cache/display-shutdown.json').exists()
    checks['no_remaining_leases'] = not list((root / 'state/piccolo/pool').glob('*/slot-*.json'))
    receipt = {'status': 'pass' if all(v is True for v in checks.values()) else 'fail',
               'source_commit': manifest['source_commit'], 'platform': os.uname().sysname,
               'checks': checks, 'forced_cleanup': forced,
               'scope': 'Native quiet defaults, compact Piccolo/health tool output, retained model result, Ctrl+O expansion, Ctrl+T native settings and shutdown. Human visual assessment separate.'}
    (root / 'display-acceptance.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    return receipt['status'] != 'pass'


if __name__ == '__main__':
    raise SystemExit(main())
