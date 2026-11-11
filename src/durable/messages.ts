import { defineDoc } from "@earendil-works/pi-durable";

export const MessagesDoc = defineDoc<{ messages: Record<string, {
  requestId: string; text: string; target: string | null; conversationId: number; submissionId: number | null;
  supervisorId?: string; queuedStageId?: number;
  remoteState?: "pending" | "routed" | "unresolved" | "rejected"; remoteReceipt?: number; remoteError?: string;
}> }>({ kind: "piccolo.messages", version: 1, scope: "session", initial: () => ({ messages: {} }) });
