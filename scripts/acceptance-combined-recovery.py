#!/usr/bin/env python3
"""Owned live combined recovery qualification. No unowned cleanup or model fallback."""
import argparse, importlib.util, json, subprocess, time
from pathlib import Path
spec=importlib.util.spec_from_file_location('jobs',Path(__file__).with_name('acceptance-session-jobs.py'))
jobs=importlib.util.module_from_spec(spec);spec.loader.exec_module(jobs)
def git(root,*args): return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
def load(p): return json.loads(p.read_text())
def shutdown(rpc, project, checks):
 """Always reap the owned process, even when its input pipe has failed."""
 try:
  if rpc.process.poll() is None:
   active=[p for p in (project/'.piccolo/jobs').glob('*/launch.json') if not p.with_name('outcome.json').exists()]
   if active:
    checks['no_active_before_teardown']=False
    try:rpc.request('new_session')
    except Exception:checks['teardown_failed']=True
   rpc.send({'type':'prompt','message':'/acceptance-exit'})
 except Exception:checks['shutdown_request_failed']=True
 finally:
  try:rpc.close()
  except Exception:checks['close_failed']=True
  finally:
   try:
    if rpc.process.poll() is None:
     checks['forced_cleanup']=True
     rpc.process.terminate()
     try:rpc.process.wait(timeout=10)
     except subprocess.TimeoutExpired:
      rpc.process.kill();rpc.process.wait(timeout=5)
   except Exception:checks['cleanup_failed']=True
   for name in ['selector','log','err']:
    try:getattr(rpc,name).close()
    except Exception:checks['stream_close_failed']=True
   checks['native_shutdown']=rpc.process.poll()==0 and (project/'.cache/shutdown.json').exists()

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();root=a.root.resolve();project=root/'project';manifest=load(root/'fixture.json');env=jobs.environment(root)
 if manifest.get('notifications')!='follow_up':raise RuntimeError('Combined recovery requires a fresh fixture prepared with --notifications follow_up; notify_only deliberately disables automatic wake')
 if (project/'.cache/jobs-rpc.jsonl').exists():raise RuntimeError('Existing run preserved; use a new fixture')
 settings=load(project/'.pi/settings.json');settings['packages'].append(str(root/'source/packages/health'))
 exitprobe=root/'exit.ts';exitprobe.write_text('import fs from "node:fs"; export default function(pi){pi.registerCommand("acceptance-exit",{handler:async(a,c)=>c.shutdown()});pi.on("session_shutdown",()=>fs.writeFileSync(".cache/shutdown.json","{}"));}')
 settings['extensions'].append(str(exitprobe));(project/'.pi/settings.json').write_text(json.dumps(settings))
 with (project/'.piccolo/config.toml').open('a') as f:
  f.write('\n[extensions.pi-harness-health]\ninterval_ms=1000\ntool_ms=30000\nattention_ms=60000\nretry_ms=10000\nmax_attempts=8\n')
  for name,model in [('implementer',manifest['gpt_model']),('reviewer',manifest['claude_model']),('qa',manifest['gpt_model'])]:f.write('\n[agents.'+name+']\nmodel='+json.dumps(model)+'\neffort="medium"\ntimeout_ms=300000\n')
  f.write('\n[jobs.implementation.validation.checks.focused]\ncommand="python3 -B -m unittest discover -s tests -p test_clean_lines.py"\nscope="Owned deterministic newline fixtures"\nboundary="isolated"\ntimeout_ms=30000\nrequired=true\n')
 (project/'.cache/worktrees').mkdir();(project/'tests').mkdir();(project/'clean_lines.py').write_text('def clean_lines(text):\n    raise NotImplementedError\n')
 (project/'tests/test_clean_lines.py').write_text("import unittest\nfrom clean_lines import clean_lines\nclass Check(unittest.TestCase):\n def test_indent(self): self.assertEqual(clean_lines('a  \\n  b\\t'), 'a\\n  b')\n def test_final(self): self.assertEqual(clean_lines('x  \\n'), 'x\\n')\n def test_empty(self): self.assertEqual(clean_lines(''), '')\n")
 with (project/'.gitignore').open('a') as f:f.write('__pycache__/\n')
 subprocess.run(['node',str(root/'source/bin/piccolo.mjs'),'configure','--cwd',str(project)],env=env,check=True,capture_output=True)
 git(project,'add','.');git(project,'-c','user.name=Qualification','-c','user.email=qualification@example.invalid','commit','-m','Prepare combined recovery fixture');base=git(project,'rev-parse','HEAD')
 failed=project/'.cache/missing/attempt';interrupted=project/'.cache/worktrees/interrupted';restored=project/'.cache/worktrees/restored';final=project/'.cache/worktrees/final';checkpoint=root/'checkpoint'
 stall="This is an intentional interrupted-attempt fixture. Use actual bash to write payload.txt with exactly staged-progress plus newline, git add payload.txt, then overwrite payload.txt with exactly unstaged-progress plus newline. Write draft-note.txt as bytes [0,1,2,255]. Then in one bash command write the shell PID to .cache/stalled-shell.pid, start sleep 180 in the background, write its PID ($!) to .cache/stalled-child.pid, touch .cache/ready-to-stop, and wait for that child with a bash tool timeout of 200 seconds. Do not commit, alter tests, or repair the deliberate stall. Wait for that command; parent will stop this owned job after health reports the deadline."
 recovery="Implement clean_lines(text) preserving indentation, all newline separators, final newline and empty input while removing trailing spaces/tabs per line. Preserve payload.txt and draft-note.txt recovered by the parent. This is a deliberate QA-revision fixture: on revision round0 implement using splitlines and join so the final newline is incorrectly lost, commit it, and report that this intentionally defective implementation is ready for the restricted review and QA failure test. Do not claim tests passed. On revision round1 correct that defect, add useful tests if needed, run the focused suite and commit the fix. No services, installs, push/merge, configuration changes or broad tests."
 overrides='[jobs.implementation.stages.review]\ntask="For round0, this acceptance review is restricted to preservation of recovered artifacts and absence of unrelated edits. Explicitly state this narrow scope; the deliberate final-newline defect belongs to the following QA stage. For round1 perform full correctness review. Do not claim round0 functional validation passed."\n[jobs.implementation.stages.qa]\ntask="Run python3 -B -m unittest discover -s tests -p test_clean_lines.py, with output saved in .cache/qa-round<round>.log and actual exit status in .cache/qa-round<round>.exit. Round0 must report changes_requested for the real failing final-newline assertion; round1 complete only after the actual test passes. Do not modify code, tests, or branches."\n'
 arguments={'task':stall,'branch':'acceptance/interrupted','worktree':str(failed),'max_revisions':0,'job':'implementation','base':base,'overrides_toml':''}
 prompt=f'''Execute this bounded combined recovery acceptance using session-owned piccolo_submit workflows, not detached subagent tools. Read this entire protocol and keep a concise .cache/recovery-notes.md if needed. Never infer job failure from an unrelated health incident.
A. Submit exactly once kind workflow arguments {json.dumps(arguments)}. Return immediately with ID. No poll/wait. When health wakes you, inspect incident and exact result; verify failed preflight did not create acceptance/interrupted. Submit B with identical task and arguments except worktree {interrupted}. Ack A with inspected revision, note and replacement B; resolve A incident. Return immediately.
B. When worker/deadline_expired wakes you, inspect B. Stop it ONLY after {interrupted}/.cache/ready-to-stop exists. If marker absent, defer the incident for 60 seconds (until is epoch milliseconds), return and let work run. Do not kill based on quiet model output alone. If marker exists, piccolo_jobs stop B and return; do not busy-poll. A completion notification will let you verify terminal cancellation and inspect preserved files. Resolve stale progress incidents once that job is terminal.
C. Once B has a terminal result, use node {root}/source/bin/piccolo.mjs checkpoint create --cwd {project} --id WORKFLOW_ID_FROM_B_RESULT --destination {checkpoint}. Restore with checkpoint restore --cwd {project} --checkpoint {checkpoint} --worktree {restored} --branch acceptance/restored. Verify original and restored payload.txt unstaged bytes, git show :payload.txt staged bytes, and binary draft-note.txt [0,1,2,255]. Do not delete originals. In restored only commit both recovered files, capturing the new SHA. Then submit C kind workflow with job implementation, branch acceptance/final, worktree {final}, base that recovered SHA, max_revisions 1, task {json.dumps(recovery)}, overrides_toml {json.dumps(overrides)}. Ack B with its inspected revision, decision note and replacement C; resolve its attention incident. Return immediately. Do not create more than these three jobs.
D. While C works, unexpected deadline incidents alone are not proof of failure: inspect progress and defer60s when healthy. C should automatically move implementation0 -> restricted review0 -> failing QA0 -> implementation1 -> full review1 -> passing QA1 -> configured required validation. When health wakes for completion, inspect exact result, stages, QA logs/exit receipts, recovered data and clean candidate. Resolve all relevant remaining incidents (including superseded progress ones), acknowledge completed result, and reply exactly COMBINED-RECOVERY-PASS followed by candidate SHA. Never emit that marker while any job remains active. If intractably blocked, preserve work, report COMBINED-RECOVERY-BLOCKED and reason. No services, installs, push/merge, branch deletion, forced cleanup or configuration changes. A separately queued user prompt may arrive to test prompt preservation; answer it without abandoning this protocol.'''
 rpc=None;checks={};start=time.monotonic();concurrent_sent=False
 try:
  rpc=jobs.Rpc(root,manifest);rpc.prompt(prompt)
  deadline=time.monotonic()+1500
  def final_message():
   for e in reversed(rpc.events):
    m=e.get('message',{})
    if e.get('type')=='message_end' and m.get('role')=='assistant' and m.get('stopReason')=='stop':
     if any(c.get('type')=='text' and c.get('text','').startswith('COMBINED-RECOVERY-') for c in m.get('content',[]) if isinstance(c,dict)):return e
  while time.monotonic()<deadline and not final_message():
   rpc.pump()
   if rpc.process.poll() is not None:raise RuntimeError('Native Pi exited before final result')
   # A genuine second input during review/QA; driver performs no recovery actions.
   if not concurrent_sent:
    records=[load(p) for p in (project/'.piccolo/workflows').glob('*/[0-9]*.json')]
    if any(r.get('stage')=='review' and r.get('round')==1 for r in records):
     rpc.send({'type':'prompt','message':'Concurrency acceptance: use bash sleep 15 with timeout20, then reply exactly CONCURRENT-PROMPT-RETAINED. Keep the existing combined recovery obligations and process their completion after this turn.','streamingBehavior':'followUp'})
     concurrent_sent=True
  if not final_message():raise TimeoutError('Combined acceptance deadline')
  last=rpc.events.index(final_message());rpc.wait(lambda:any(e.get('type')=='agent_settled' for e in rpc.events[last+1:]),30)
  launches=list((project/'.piccolo/jobs').glob('*/launch.json'));outcomes=[load(p) for p in (project/'.piccolo/jobs').glob('*/outcome.json')]
  checks['exactly_three_terminal_jobs']=len(launches)==len(outcomes)==3
  checks['no_active_before_teardown']=all(p.with_name('outcome.json').exists() for p in launches)
  checks['one_failed_preflight']=sum('parent must already exist' in o.get('result',{}).get('summary','') for o in outcomes)==1
  checks['one_cancelled_attempt']=sum(o.get('state')=='cancelled' and o.get('result',{}).get('status')=='interrupted' for o in outcomes)==1
  done=[o['result'] for o in outcomes if o.get('result',{}).get('status')=='complete'];checks['one_completed_workflow']=len(done)==1
  checks['checkpoint_exists']=(checkpoint/'manifest.json').is_file()
  checks['preserved_staged_original']=git(interrupted,'show',':payload.txt')=='staged-progress'
  checks['preserved_unstaged_original']=(interrupted/'payload.txt').read_bytes()==b'unstaged-progress\n'
  checks['preserved_binary_original']=(interrupted/'draft-note.txt').read_bytes()==bytes([0,1,2,255])
  checks['restored_data']=(restored/'payload.txt').read_bytes()==b'unstaged-progress\n' and (restored/'draft-note.txt').read_bytes()==bytes([0,1,2,255])
  if done:
   result=done[0];records=[load(p) for p in Path(result['record']).glob('[0-9]*.json')]
   for stage in ['implement','review','qa']:checks[stage+'_two_rounds']=sorted(r['round'] for r in records if r.get('stage')==stage)==[0,1]
   checks['qa_failure_then_pass']=[r['report']['status'] for r in sorted(records,key=lambda r:r.get('round',0)) if r.get('stage')=='qa']==['changes_requested','complete']
   checks['real_qa_exits']=(final/'.cache/qa-round0.exit').read_text().strip()=='1' and (final/'.cache/qa-round1.exit').read_text().strip()=='0'
   checks['configured_validation']=result['validation']['status']=='complete' and len(result['validation']['checks'])==1
   checks['candidate_clean']=not git(final,'status','--porcelain')
   checks['final_data']=(final/'payload.txt').read_bytes()==b'unstaged-progress\n' and (final/'draft-note.txt').read_bytes()==bytes([0,1,2,255])
   checks['descends_from_restoration']=subprocess.run(['git','-C',str(final),'merge-base','--is-ancestor',git(restored,'rev-parse','HEAD'),result['candidate']],capture_output=True).returncode==0
  decisions=[load(p) for p in (project/'.piccolo/jobs').glob('*/[0-9]*.json') if load(p).get('kind')=='parent_decision']
  checks['all_parent_decisions']=len(decisions)==3;checks['two_supersessions']=sum(d.get('disposition')=='superseded' for d in decisions)==2
  incidents=[i for p in (root/'state/pi-harness-health').glob('*/*.json') for i in load(p).get('incidents',[])]
  checks['deadline_detected']=any(i['component']=='worker' and i['code']=='deadline_expired' for i in incidents)
  checks['incidents_disposed']=all(i['disposition'] in ['resolved','superseded'] for i in incidents)
  checks['concurrent_prompt_retained']=concurrent_sent and any(e.get('type')=='message_end' and e.get('message',{}).get('stopReason')=='stop' and any(c.get('type')=='text' and c.get('text','').strip()=='CONCURRENT-PROMPT-RETAINED' for c in e.get('message',{}).get('content',[]) if isinstance(c,dict)) for e in rpc.events if e.get('message',{}).get('role')=='assistant')
  checks['parent_final']=any(c.get('text','').startswith('COMBINED-RECOVERY-PASS') for c in final_message()['message']['content'] if isinstance(c,dict))
  checks['parent_base_unchanged']=git(project,'rev-parse','HEAD')==base
  for name in ['shell','child']:
   pid=int((interrupted/('.cache/stalled-'+name+'.pid')).read_text());checks['stalled_'+name+'_gone']=subprocess.run(['kill','-0',str(pid)],capture_output=True).returncode!=0
 except (Exception,KeyboardInterrupt) as e:checks['runner_error']=type(e).__name__
 finally:
  if rpc:shutdown(rpc,project,checks)
 checks['no_remaining_leases']=not list((root/'state/piccolo/pool').glob('*/slot-*.json'))
 failures=['runner_error','teardown_failed','shutdown_request_failed','close_failed','forced_cleanup','cleanup_failed','stream_close_failed']
 result={'status':'pass' if checks and not any(k in checks for k in failures) and all(v is True for v in checks.values()) else 'fail','checks':checks,'source_commit':manifest['source_commit'],'elapsed_seconds':round(time.monotonic()-start,3),'scope':'One live parent, failed launch, health-driven stop, lossless checkpoint/restore, real failing QA/revision, concurrent submitted input and autonomous completion. Draft-field/TUI acceptance separate.'}
 (root/'combined-acceptance.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));return result['status']!='pass'
if __name__=='__main__':raise SystemExit(main())
