#!/usr/bin/env node
import { readExperiment, reportExperiment, assessExperiment, compareExperiments } from "../src/experiments.ts";
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "smol-toml";
import { loadConfig } from "../src/config.ts";
import { projectRoot } from "../src/records.ts";
import { applyProfile } from "../src/profiles.ts";
import { inspectConfig } from "../src/inspection.ts";
import { setup } from "../src/setup.ts";
import { planProject, prepareProject, verifyDeployment, configureWithPi } from "../src/onboarding.ts";
import { checkpointWorkflow, restoreCheckpoint } from "../src/worktree-checkpoint.ts";
import { exportWorkflow, auditStagedRecords } from "../src/portable-records.ts";
import { executeCheck, readCheck } from "../src/validation.ts";
import { configuredWorker, experimentClient } from "../src/durable/client.ts";
import { remoteClient } from "../src/remote.ts";
import { planWorktreeArea, prepareWorktreeArea, worktreeName } from "../src/worktree-placement.ts";
import { git } from "../src/workflow.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    [...(["cwd", "profile", "overrides", "pointer", "type", "host", "id", "task-file", "model", "effort", "timeout-ms", "pi", "deployment", "bin-dir", "destination", "checkpoint", "worktree", "branch", "spec", "policy"].map(k => [k, { type: "string" }])), ...["dry-run", "blackhole", "no-bin", "help"].map(k => [k, { type: "boolean" }])]) });
  const [command, action, ...extra] = positionals;
  if (values.help || !command) {
    console.log("Usage: piccolo worktree plan|prepare [--branch NAME] [--cwd PROJECT]\n       piccolo experiment plan --spec FILE [--cwd PROJECT]\n       piccolo experiment report --id UUID [--host DURABLE_HOST] [--cwd PROJECT]\n       piccolo experiment compare --id UUID,UUID [--host DURABLE_HOST] [--cwd PROJECT]\n       piccolo experiment assess --id UUID --spec JSON_FILE [--host DURABLE_HOST] [--cwd PROJECT]\n       piccolo records export --id WORKFLOW_UUID [--cwd PROJECT]\n       piccolo records audit [--policy FILE] [--cwd PROJECT]\n       piccolo check run --spec FILE [--cwd CANDIDATE_WORKTREE]\n       piccolo check inspect --id UUID [--cwd CANDIDATE_WORKTREE]\n       piccolo checkpoint create --id WORKFLOW --destination NEW_PATH [--cwd PROJECT]\n       piccolo checkpoint restore --checkpoint PATH --worktree NEW_PATH --branch NEW_BRANCH [--cwd PROJECT]\n       piccolo setup [--deployment native] [--blackhole] [--bin-dir PATH | --no-bin] [--pi PATH] [--dry-run]\n       piccolo init [--cwd PATH] [--pi PATH] [--dry-run]\n       piccolo configure [--cwd PATH]\n       piccolo config show|explain [--cwd PATH] [--profile NAME] [--overrides FILE] [--pointer /path] [--type TYPE]\n       piccolo remote start|status --host NAME [--cwd PATH] [--id UUID] [--task-file FILE] [--model PROVIDER/ID] [--effort LEVEL] [--timeout-ms N]");
    process.exit(0);
  }
  if (extra.length) throw new Error("Unexpected positional arguments");
  const allowed = command === "worktree" ? ["cwd", "branch"] : command === "experiment" ? ["cwd", "spec", "id", "host"] : command === "records" ? ["cwd", "id", "policy"] : command === "check" ? ["cwd", "spec", "id"] : command === "checkpoint" ? ["cwd", "id", "destination", "checkpoint", "worktree", "branch"] : command === "setup" ? ["pi", "deployment", "blackhole", "bin-dir", "no-bin", "dry-run"] : command === "init" ? ["cwd", "pi", "dry-run"] : command === "configure" ? ["cwd"] : command === "config" ? ["cwd", "profile", "overrides", "pointer", "type"] : command === "remote" ? ["cwd", "host", "id", "task-file", "model", "effort", "timeout-ms"] : [];
  if (Object.keys(values).some(k => !allowed.includes(k))) throw new Error("Option is not supported by this command");
  if (["setup", "init"].includes(command)) {
    if (action) throw new Error("Unexpected positional argument");
    let result;
    if (command === "setup") result = setup({ pi: values.pi, deployment: values.deployment, blackhole: values.blackhole, binDir: values["bin-dir"], noBin: values["no-bin"], dryRun: values["dry-run"] });
    else {
      const plan = planProject(path.resolve(values.cwd ?? process.cwd()));
      const deployment = await verifyDeployment(plan.root);
      if (values["dry-run"]) result = { ...plan, deployment };
      else { prepareProject(plan.root); result = await configureWithPi(plan.root, values.pi); }
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  const cwd = path.resolve(values.cwd ?? process.cwd());
  if (command === "worktree") {
    if (!["plan", "prepare"].includes(action)) throw new Error("Use worktree plan|prepare [--branch NAME] [--cwd PATH]");
    const name = values.branch ? worktreeName(values.branch) : undefined;
    if (values.branch) git(cwd, "check-ref-format", "refs/heads/" + values.branch);
    const result = (action === "plan" ? planWorktreeArea : prepareWorktreeArea)(cwd);
    if (name) result.worktree = path.join(result.area, name);
    console.log(JSON.stringify(result, null, 2)); process.exit(0);
  }
  const root = projectRoot(cwd);
  if (command === "experiment") {
    let result;
    if (values.host && values.id) result = await experimentClient(root, configuredWorker(loadConfig(root), values.host), action, values.id.split(","), values.spec ? path.resolve(cwd, values.spec) : undefined);
    else if (action === "plan" && values.spec && !values.id && !values.host) result = readExperiment(path.resolve(cwd, values.spec));
    else if (action === "report" && values.id && !values.spec) result = reportExperiment(root, values.id);
    else if (action === "compare" && values.id && !values.spec) result = compareExperiments(root, values.id.split(","));
    else if (action === "assess" && values.id && values.spec) result = assessExperiment(root, values.id, JSON.parse(fs.readFileSync(values.spec, "utf8")));
    else throw new Error("Use experiment plan/report/compare/assess with the documented options");
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result, null, 2) + "\n", error => error ? reject(error) : resolve()));
    process.exit(0);
  }
  if (command === "records") {
    let result;
    if (action === "export" && values.id && !values.policy) result = exportWorkflow(root, values.id);
    else if (action === "audit" && !values.id) result = auditStagedRecords(root, values.policy);
    else throw new Error("Use records export --id WORKFLOW_UUID or records audit");
    console.log(JSON.stringify(result, null, 2)); process.exit(result.status === "needs_review" ? 1 : 0);
  }
  if (command === "check") {
    let result;
    if (action === "run" && values.spec && !values.id) result = await executeCheck(root, JSON.parse(fs.readFileSync(values.spec, "utf8")));
    else if (action === "inspect" && values.id && !values.spec) result = readCheck(root, values.id);
    else throw new Error("Use check run --spec FILE or check inspect --id UUID");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "pass" ? 0 : 1);
  }
  if (command === "checkpoint") {
    let result;
    if (action === "create" && values.id && values.destination && !values.checkpoint && !values.worktree && !values.branch)
      result = checkpointWorkflow(root, values.id, values.destination);
    else if (action === "restore" && values.checkpoint && values.worktree && values.branch && !values.id && !values.destination)
      result = restoreCheckpoint(root, values.checkpoint, values.worktree, values.branch);
    else throw new Error("Use checkpoint create --id WORKFLOW --destination NEW_PATH or restore --checkpoint PATH --worktree NEW_PATH --branch NEW_BRANCH");
    console.log(JSON.stringify(result, null, 2)); process.exit(0);
  }
  const resolved = loadConfig(root, { profile: values.profile, invocation: values.overrides ? parse(fs.readFileSync(values.overrides, "utf8")) : {} });
  let result;
  if (command === "configure" && !action) {
    const configured = applyProfile(cwd, resolved);
    result = { profile: configured.profile, policy_digest: configured.policy_digest, cwd, next: "Restart Pi to activate this configuration." };
  } else if (command === "config" && ["show", "explain"].includes(action)) {
    result = inspectConfig(resolved, values.pointer, values.type);
  } else if (command === "remote" && ["start", "status"].includes(action)) {
    if (!values.host) throw new Error("Remote execution requires --host NAME");
    if (action === "status" && ["task-file", "model", "effort", "timeout-ms"].some(k => values[k] !== undefined)) throw new Error("Status cannot change or replay job inputs");
    result = await remoteClient(root, resolved, values.host, action, { id: values.id,
      task: values["task-file"] ? fs.readFileSync(values["task-file"], "utf8") : undefined,
      model: values.model, effort: values.effort, timeout_ms: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]) });
  } else throw new Error("Usage: piccolo configure [--cwd PATH] | config show|explain [--pointer /path] [--type TYPE] [--profile NAME] [--overrides FILE] [--cwd PATH] | remote start|status --host NAME [--id UUID] [--task-file FILE] [--model PROVIDER/ID] [--effort LEVEL] [--timeout-ms N] [--cwd PATH]");
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
