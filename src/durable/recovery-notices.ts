import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { submissionSchema } from "./contract.ts";
import { requireIgnoredArtifacts } from "./artifacts.ts";

function directory(root: string) {
  const target = path.join(fs.realpathSync(root), ".cache", "piccolo", "dispatch");
  if (fs.realpathSync(target) !== target || !fs.lstatSync(target).isDirectory()) throw new Error("Recovery notices require the original real dispatch directory");
  return target;
}
function readFile(file: string, limit: number) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Invalid recovery notice or retained intent");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function recoveryNoticeDismissed(root: string, id: string, intent: unknown) {
  z.string().uuid().parse(id);
  try {
    const file = path.join(directory(root), `${id}.dismissed.json`);
    if (!fs.existsSync(file)) return false;
    const value = readFile(file, 16000); return value.version === 1 && value.id === id && value.intent === digest(intent) && value.dismissed === true;
  }
  catch { return false; } // Invalid advisory state cannot hide work.
}
/** Dismiss only the notice. No transport, cancellation, transcript deletion or ownership change. */
export function setRecoveryNotice(root: string, id: string, dismissed: boolean) {
  z.string().uuid().parse(id);
  const target = directory(root), intent = readFile(path.join(target, `${id}.json`), 9 * 1024 * 1024);
  const submission = submissionSchema.parse(intent.submission);
  if (submission.requestId !== id || submission.lifetime !== "independent") throw new Error("Only retained independent Job notices can be dismissed");
  const file = path.join(target, `${id}.dismissed.json`), temporary = path.join(target, `.${randomUUID()}.notice.tmp`);
  requireIgnoredArtifacts(root, [path.join(target, `${id}.json`), file, temporary]);
  if (fs.existsSync(file)) readFile(file, 16000);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, id, intent: digest(intent), dismissed }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
