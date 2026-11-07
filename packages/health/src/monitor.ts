import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type HealthComponent = "attention" | "compaction" | "endpoint" | "worker" | "monitor";
export type HealthCode = "wake_overdue" | "unacknowledged" | "compaction_failed" | "compaction_overdue" |
  "owner_mismatch" | "transport" | "timeout" | "rate_limit" | "authentication" | "unavailable" |
  "missing_receipt" | "deadline_expired" | "unsupported_tool" | "accounting_mismatch" |
  "worker_failed" | "diagnosis_failed" | "monitor_overdue";
export type HealthDisposition = "open" | "handling" | "deferred" | "resolved" | "development" | "superseded";
export type HealthReason = "observed" | "parent_inspecting" | "retry_later" | "verified_recovery" |
  "user_action" | "development_fix" | "superseded" | "retry_exhausted" | "unsupported_recovery";
export type HealthAction = { id: string; incidentId: string; kind: "request_parent_attention"; attempt: number };
type BusyReceipt = { firstAt: number; lastAt: number; count: number; observations: number[] };
type ActionReceipt = HealthAction & { at: number; result?: "delivered" | "failed" | "unsupported"; finishedAt?: number;
  pending?: boolean; dispatchedAt?: number; busy?: BusyReceipt };
type DecisionReceipt = { at: number; disposition: HealthDisposition; reason: HealthReason; until?: number };
export type HealthIncident = {
  id: string; source: string; session: string; runtime: string; component: HealthComponent; code: HealthCode;
  firstSeen: number; lastSeen: number; count: number; occurrences: number[];
  disposition: HealthDisposition; reason: HealthReason; nextCheck: number;
  actions: ActionReceipt[];
  decisions: DecisionReceipt[];
};
type Expectation = { source: string; component: HealthComponent; code: HealthCode; deadline: number };
type RecordFile = { format: 1; runtime: string; session: string; incidents: HealthIncident[]; expectations: Expectation[] };
export type HealthObservation = { source: string; component: HealthComponent; code: HealthCode };
export type HealthMonitorOptions = {
  directory: string; session: string; runtime?: string; now?: () => number;
  maxIncidents?: number; maxAttempts?: number; maxActionsPerRuntime?: number; baseRetryMs?: number; maxRetryMs?: number;
  acknowledgementMs?: number; maxActionsPerTick?: number;
};
const components: HealthComponent[] = ["attention", "compaction", "endpoint", "worker", "monitor"];
const codes: HealthCode[] = ["wake_overdue", "unacknowledged", "compaction_failed", "compaction_overdue", "owner_mismatch",
  "transport", "timeout", "rate_limit", "authentication", "unavailable", "missing_receipt", "deadline_expired",
  "unsupported_tool", "accounting_mismatch", "worker_failed", "diagnosis_failed", "monitor_overdue"];
const dispositions: HealthDisposition[] = ["open", "handling", "deferred", "resolved", "development", "superseded"];
const reasons: HealthReason[] = ["observed", "parent_inspecting", "retry_later", "verified_recovery", "user_action",
  "development_fix", "superseded", "retry_exhausted", "unsupported_recovery"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const opaque = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function positive(value: number, name: string, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid health ${name}`);
  return value;
}
function observation(input: HealthObservation): Expectation {
  if (typeof input.source !== "string" || !input.source || input.source.length > 4096 ||
      !components.includes(input.component) || !codes.includes(input.code)) throw new Error("Invalid categorical health observation");
  // Hash identifiers, and select fields rather than serializing caller objects/errors.
  return { source: hash(input.source), component: input.component, code: input.code, deadline: 0 };
}
function validExpectation(e: any): e is Expectation {
  return !!e && opaque(e.source) && components.includes(e.component) && codes.includes(e.code) && time(e.deadline);
}
function parseRecord(raw: string): RecordFile {
  const r = JSON.parse(raw);
  if (!r || r.format !== 1 || !uuid(r.runtime) || !opaque(r.session) || !Array.isArray(r.incidents) ||
      r.incidents.length > 4096 || !Array.isArray(r.expectations) || r.expectations.length > 4096) throw new Error("Invalid health record");
  const incidents = r.incidents.map((i: any): HealthIncident => {
    if (!i || !opaque(i.id) || !opaque(i.source) || i.runtime !== r.runtime || i.session !== r.session ||
        !components.includes(i.component) || !codes.includes(i.code) || !time(i.firstSeen) || !time(i.lastSeen) ||
        !Number.isSafeInteger(i.count) || i.count < 1 || !dispositions.includes(i.disposition) || !reasons.includes(i.reason) ||
        !time(i.nextCheck) || !Array.isArray(i.occurrences) || i.occurrences.length > 32 || !i.occurrences.every(time) ||
        !Array.isArray(i.actions) || i.actions.length > 20) throw new Error("Invalid health incident");
    const actions = i.actions.map((a: any): ActionReceipt => {
      if (!a || !uuid(a.id) || a.incidentId !== i.id || a.kind !== "request_parent_attention" ||
          !Number.isSafeInteger(a.attempt) || a.attempt < 1 || a.attempt > 20 || !time(a.at) ||
          (a.result !== undefined && !["delivered", "failed", "unsupported"].includes(a.result)) ||
          (a.finishedAt !== undefined && !time(a.finishedAt))) throw new Error("Invalid health action receipt");
      if ((a.pending !== undefined && typeof a.pending !== "boolean") || (a.pending && (a.result !== undefined || a.finishedAt !== undefined || !a.busy)) ||
          (a.dispatchedAt !== undefined && !time(a.dispatchedAt))) throw new Error("Invalid pending health action");
      let busy: BusyReceipt | undefined;
      if (a.busy !== undefined) {
        const b = a.busy;
        if (!b || !time(b.firstAt) || !time(b.lastAt) || !Number.isSafeInteger(b.count) || b.count < 1 ||
            !Array.isArray(b.observations) || b.observations.length < 1 || b.observations.length > 32 ||
            b.count < b.observations.length || !b.observations.every(time)) throw new Error("Invalid health busy receipt");
        busy = { firstAt: b.firstAt, lastAt: b.lastAt, count: b.count, observations: [...b.observations] };
      }
      return { id: a.id, incidentId: a.incidentId, kind: a.kind, attempt: a.attempt, at: a.at,
        ...(a.result === undefined ? {} : { result: a.result }), ...(a.finishedAt === undefined ? {} : { finishedAt: a.finishedAt }),
        ...(a.pending === undefined ? {} : { pending: a.pending }), ...(a.dispatchedAt === undefined ? {} : { dispatchedAt: a.dispatchedAt }),
        ...(busy === undefined ? {} : { busy }) };
    });
    if (!Array.isArray(i.decisions) || i.decisions.length > 32) throw new Error("Invalid health decisions");
    const decisions = i.decisions.map((d: any): DecisionReceipt => {
      if (!d || !time(d.at) || !dispositions.includes(d.disposition) || !reasons.includes(d.reason) ||
          (d.until !== undefined && !time(d.until))) throw new Error("Invalid health decision receipt");
      return { at: d.at, disposition: d.disposition, reason: d.reason, ...(d.until === undefined ? {} : { until: d.until }) };
    });
    return { id: i.id, source: i.source, runtime: i.runtime, session: i.session, component: i.component, code: i.code,
      firstSeen: i.firstSeen, lastSeen: i.lastSeen, count: i.count, occurrences: [...i.occurrences], disposition: i.disposition,
      reason: i.reason, nextCheck: i.nextCheck, actions, decisions };
  });
  const expectations = r.expectations.map((e: any) => {
    if (!validExpectation(e)) throw new Error("Invalid health expectation");
    return { source: e.source, component: e.component, code: e.code, deadline: e.deadline };
  });
  return { format: 1, runtime: r.runtime, session: r.session, incidents, expectations };
}

/** Deterministic, passive health ledger. It never executes recovery or adopts old sessions.
 * The owner calls tick on its schedule and serializes the returned safe control requests.
 * Delivery is not acknowledgment; only an explicit disposition records the parent's decision.
 */
export class HealthMonitor {
  readonly runtime: string;
  readonly session: string;
  private current: RecordFile;
  private archive: HealthIncident[] = [];
  private file: string;
  private closed = false;
  private now: () => number;
  private maxIncidents: number;
  private maxAttempts: number;
  private maxActionsPerRuntime: number;
  private baseRetryMs: number;
  private maxRetryMs: number;
  private acknowledgementMs: number;
  private maxActionsPerTick: number;

  constructor(options: HealthMonitorOptions) {
    this.runtime = options.runtime ?? randomUUID();
    if (!uuid(this.runtime) || typeof options.session !== "string" || !options.session || options.session.length > 4096)
      throw new Error("Invalid health runtime/session identity");
    this.session = hash(options.session);
    this.now = options.now ?? Date.now;
    this.maxIncidents = positive(options.maxIncidents ?? 512, "incident limit", 4096);
    this.maxAttempts = positive(options.maxAttempts ?? 4, "attempt limit", 20);
    this.maxActionsPerRuntime = positive(options.maxActionsPerRuntime ?? 128, "runtime action limit", 10000);
    this.baseRetryMs = positive(options.baseRetryMs ?? 30_000, "retry delay");
    this.maxRetryMs = positive(options.maxRetryMs ?? 600_000, "maximum retry delay");
    this.acknowledgementMs = positive(options.acknowledgementMs ?? 120_000, "acknowledgment deadline");
    this.maxActionsPerTick = positive(options.maxActionsPerTick ?? 1, "action batch", 20);
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("Health storage must be an owned private directory");
    const directory = fs.realpathSync(options.directory);
    this.file = path.join(directory, `${this.runtime}.json`);
    // Load a bounded historical subset; all snapshots remain on disk for direct inspection.
    const names = fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(-128);
    for (const name of names) {
      const file = path.join(directory, name);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const entry = fs.fstatSync(fd);
        if (!entry.isFile() || entry.size > 8_000_000 || (entry.mode & 0o077) !== 0 ||
            (process.getuid && entry.uid !== process.getuid())) throw new Error("Unsafe health record");
        const record = parseRecord(fs.readFileSync(fd, "utf8"));
        if (`${record.runtime}.json` !== name) throw new Error("Health record identity mismatch");
        this.archive = [...this.archive, ...record.incidents].slice(-this.maxIncidents);
      } finally { fs.closeSync(fd); }
    }
    if (fs.existsSync(this.file)) throw new Error("Health runtime identity already exists; use a new runtime");
    this.current = { format: 1, session: this.session, runtime: this.runtime, incidents: [], expectations: [] };
    this.persist(this.current);
  }
  private clock() {
    const now = this.now();
    if (!time(now)) throw new Error("Invalid health clock");
    return now;
  }
  private persist(record: RecordFile) {
    const bytes = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(bytes) > 8_000_000) throw new Error("Health record size limit reached");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }
  private change<T>(update: (record: RecordFile) => T): T {
    if (this.closed) throw new Error("Health monitor is closed");
    const next = structuredClone(this.current);
    const result = update(next);
    this.persist(next); this.current = next;
    return structuredClone(result);
  }
  private add(record: RecordFile, signal: Expectation, now: number): HealthIncident {
    const id = hash(`${this.runtime}:${signal.source}:${signal.component}:${signal.code}`);
    let incident = record.incidents.find(i => i.id === id);
    if (incident) {
      incident.count++; incident.lastSeen = now;
      incident.occurrences = [...incident.occurrences, now].slice(-32);
      if (["resolved", "superseded"].includes(incident.disposition)) {
        incident.disposition = "open"; incident.reason = "observed"; incident.nextCheck = now;
        this.decision(incident, now);
      }
    } else {
      if (record.incidents.length >= this.maxIncidents) throw new Error("Health incident limit reached; evidence retained");
      incident = { id, source: signal.source, session: this.session, runtime: this.runtime,
        component: signal.component, code: signal.code, firstSeen: now, lastSeen: now,
        count: 1, occurrences: [now], disposition: "open", reason: "observed", nextCheck: now, actions: [],
        decisions: [{ at: now, disposition: "open", reason: "observed" }] };
      record.incidents.push(incident);
    }
    return incident;
  }
  observe(input: HealthObservation): HealthIncident {
    const signal = observation(input); const now = this.clock();
    return this.change(record => this.add(record, signal, now));
  }
  expect(input: HealthObservation & { deadline: number }): void {
    const signal = observation(input);
    if (!time(input.deadline)) throw new Error("Invalid health expectation deadline");
    signal.deadline = input.deadline;
    this.change(record => {
      const existing = record.expectations.find(e => e.source === signal.source && e.component === signal.component && e.code === signal.code);
      if (existing) existing.deadline = Math.min(existing.deadline, signal.deadline);
      else {
        if (record.expectations.length >= this.maxIncidents) throw new Error("Health expectation limit reached");
        record.expectations.push(signal);
      }
    });
  }
  /** Stops a pending deadline; does not claim that an already raised incident was resolved. */
  complete(source: string): void {
    this.change(record => { record.expectations = record.expectations.filter(e => e.source !== hash(source)); });
  }
  tick(options: { dispatch?: boolean } = {}): HealthAction[] {
    const now = this.clock();
    return this.change(record => {
      for (const e of record.expectations.filter(e => e.deadline <= now)) this.add(record, e, now);
      record.expectations = record.expectations.filter(e => e.deadline > now);
      const result: HealthAction[] = [];
      if (options.dispatch === false) return result;
      // A persisted claim conservatively reserves a wake until a receipt says
      // explicitly that admission was busy. Unknown outcomes still spend budget.
      let remaining = this.maxActionsPerRuntime - record.incidents.reduce((sum, i) => sum + i.actions.filter(a => !a.pending).length, 0);
      for (const i of record.incidents) {
        if (!["open", "handling", "deferred"].includes(i.disposition) || i.nextCheck > now) continue;
        const spent = i.actions.filter(a => !a.pending).length;
        // Claims returned by this batch may still receive non-admission/busy
        // receipts. Reserve their slots, but do not permanently exhaust other
        // obligations before those receipts have been recorded.
        if (remaining <= 0 && result.length > 0) continue;
        if (spent >= this.maxAttempts || remaining <= 0) {
          i.disposition = "development"; i.reason = "retry_exhausted"; this.decision(i, now); continue;
        }
        if (result.length >= this.maxActionsPerTick) continue;
        const pending = i.actions.find(a => a.pending);
        const action: HealthAction = pending
          ? { id: pending.id, incidentId: i.id, kind: pending.kind, attempt: pending.attempt }
          : { id: randomUUID(), incidentId: i.id, kind: "request_parent_attention", attempt: spent + 1 };
        if (pending) { pending.pending = false; pending.dispatchedAt = now; }
        else i.actions.push({ ...action, at: now });
        i.nextCheck = now + Math.max(this.acknowledgementMs, this.backoff(action.attempt));
        i.disposition = "open";
        result.push(action); remaining--;
      }
      return result;
    });
  }
  private backoff(attempt: number) { return Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** (attempt - 1)); }
  private decision(incident: HealthIncident, at: number, until?: number) {
    incident.decisions = [...incident.decisions, { at, disposition: incident.disposition, reason: incident.reason,
      ...(until === undefined ? {} : { until }) }].slice(-32);
  }
  recordAction(id: string, result: "delivered" | "failed" | "unsupported" | "busy"): void {
    if (!["delivered", "failed", "unsupported", "busy"].includes(result)) throw new Error("Invalid recovery result");
    const now = this.clock();
    this.change(record => {
      const incident = record.incidents.find(i => i.actions.some(a => a.id === id));
      const action = incident?.actions.find(a => a.id === id);
      if (!incident || !action) throw new Error("Unknown health action");
      if (action.result !== undefined) {
        if (action.result !== result) throw new Error("Conflicting health action receipt");
        return;
      }
      if (result === "busy") {
        if (action.pending) return; // Repeating this receipt is idempotent.
        const previous = action.busy;
        action.busy = { firstAt: previous?.firstAt ?? now, lastAt: now,
          count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1),
          observations: [...(previous?.observations ?? []), now].slice(-32) };
        action.pending = true;
        const retryAt = now + this.backoff(Math.min(action.busy.count, 31));
        if (incident.disposition === "open") incident.nextCheck = retryAt;
        else if (["handling", "deferred"].includes(incident.disposition))
          incident.nextCheck = Math.max(incident.nextCheck, retryAt);
        return;
      }
      if (action.pending) throw new Error("Health action is awaiting admission; conflicting receipt");
      action.result = result; action.finishedAt = now;
      if (result === "unsupported" && !["resolved", "superseded"].includes(incident.disposition)) {
        incident.disposition = "development"; incident.reason = "unsupported_recovery";
        this.decision(incident, now);
      } else if (result === "failed" && incident.disposition === "open") {
        incident.nextCheck = Math.max(incident.nextCheck, now + this.backoff(action.attempt));
      }
    });
  }
  disposition(id: string, disposition: Exclude<HealthDisposition, "open">, options: { reason: HealthReason; until?: number }): void {
    if (!dispositions.includes(disposition) || disposition === ("open" as string) || !reasons.includes(options.reason))
      throw new Error("Invalid health disposition");
    const now = this.clock();
    if (options.until !== undefined && !time(options.until)) throw new Error("Invalid health recheck timestamp");
    if ((disposition === "deferred" || disposition === "handling") &&
        (!time(options.until) || options.until <= now)) throw new Error("Handling/deferred incidents require a future recheck");
    this.change(record => {
      const incident = record.incidents.find(i => i.id === id);
      if (!incident) throw new Error("Unknown current-runtime health incident");
      incident.disposition = disposition; incident.reason = options.reason;
      if (options.until !== undefined) incident.nextCheck = options.until;
      this.decision(incident, now, options.until);
    });
  }
  list(options: { includeHistory?: boolean } = {}): HealthIncident[] {
    return structuredClone(options.includeHistory ? [...this.archive, ...this.current.incidents] : this.current.incidents);
  }
  close(): void { this.closed = true; }
}
