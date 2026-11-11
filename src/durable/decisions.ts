import { defineDoc } from "@earendil-works/pi-durable";
type Decision = { disposition: "acknowledged" | "superseded"; revision: string; note: string; at: string; replacement?: string };
export const Decisions = defineDoc<{ decisions: Record<string, Decision>; history?: Record<string, Decision[]> }>({ kind: "piccolo.decisions", version: 1, scope: "session", initial: () => ({ decisions: {} }) });
