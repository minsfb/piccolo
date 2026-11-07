import fs from "node:fs";
import { DefaultResourceLoader, formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { StageSpec } from "./contract.ts";

async function resources(cwd: string) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  return loader;
}

export async function validateWorkerSkills(cwd: string, spec: StageSpec) {
  if (!spec.skills?.length) return;
  const skills = (await resources(cwd)).getSkills().skills;
  for (const name of spec.skills) if (!skills.some(skill => skill.name === name)) throw new Error(`Unavailable worker skill: ${name}`);
}

/** Resolve native packages on the execution host. The resulting instructions are
 * committed with the stage conversation, so recovery does not reread these files.
 */
export async function workerInstructions(cwd: string, spec: StageSpec) {
  const loader = await resources(cwd), skills = loader.getSkills().skills;
  const selected = (spec.skills ?? []).map(name => {
    const skill = skills.find(skill => skill.name === name);
    if (!skill) throw new Error(`Unavailable worker skill: ${name}`);
    return `# Required skill: ${name}\nSource: ${skill.filePath}\n${fs.readFileSync(skill.filePath, "utf8")}`;
  });
  return [...loader.getAgentsFiles().agentsFiles.map(file => `# ${file.path}\n${file.content}`), formatSkillsForPrompt(skills), ...selected].filter(Boolean).join("\n\n");
}
