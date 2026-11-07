export type WorktreeArea = { format: number; ownerRoot: string; area: string; ignoreFile: string; ignoreRule: string; ignoreMissing: boolean; areaMissing: boolean };
export function owningRepository(cwd: string): string;
export function worktreeName(branch: string): string;
export function defaultWorktreePath(cwd: string, branch: string): string;
export function planWorktreeArea(cwd: string): WorktreeArea;
export function prepareWorktreeArea(cwd: string): WorktreeArea;
export function planWorktreeParent(cwd: string, destination: string): WorktreeArea | undefined;
export function prepareWorktreeParent(cwd: string, destination: string): WorktreeArea | undefined;
