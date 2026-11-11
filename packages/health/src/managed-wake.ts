/** Opt-in compatibility adapter for an exactly qualified embedded Pi runtime.
 * All original methods, model bootstrap, tools, and security hooks remain in
 * use. This is not an upstream API: absent/mismatching profiles fail closed. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { WakeReceipt, WakeRequest } from "./wake.ts";

export const LEGACY_QUALIFIED_METHODS = ["prompt", "sendCustomMessage", "_runAgentPrompt", "abort", "dispose", "_bindExtensionCore", "isIdle", "isStreaming", "_checkCompaction", "_tryExecuteExtensionCommand"] as const;
export const QUALIFIED_METHODS = [...LEGACY_QUALIFIED_METHODS.filter(name => name !== "_runAgentPrompt"), "_startRun", "_prepareRun", "_normalizePromptImages"] as const;
export const CLEANUP_METHODS = ["_emitAgentSettled", "_resolveIdleWaitIfIdle"] as const;
export type ManagedWakeProfile = { id: string; version: string; platform?: NodeJS.Platform; boundHashes: Record<"emitInput" | "emitBeforeAgentStart" | "checkAuth", string>; hashes: Record<string, string> };
// Qualified from the normal managed Linux executable; source bodies stay private.
export const MANAGED_0851_PROFILE: ManagedWakeProfile = {
  "id": "managed-linux-0.85.1-20260921-r2",
  "platform": "linux",
  "version": "0.85.1",
  "boundHashes": {"emitInput": "0124b5b8c54f0dba56fdf365c993bba09bc8529141496a9cfbae146bb8c560bc", "emitBeforeAgentStart": "817af8940a25c06ace404969ed5ba88a8ea86a457220d0b5f62d77e492db012a", "checkAuth": "2b35dec51cdb92924b4fa8e0ec87d21aeb5beb46ec60973d672a7c07c27a132a"},
  "hashes": {
    "_checkCompaction": "7a02dac8faf5cfb360c8c99ede7b85bc635ffc8093b785c53d9189af7740f629",
    "_tryExecuteExtensionCommand": "fe714e6a3cb90563b83ce737783a6c166047bac767101272ea29ac74b110d3e1",

    "prompt": "1a00592c718367d97bd9b360a04881af04df44fb8a0c9fcc7768fe35c4f041db",
    "sendCustomMessage": "d19d66c8efb8adb2d2d9f8ef9b3e9a09fe9fd57e52600fd6b7f88fe36f56c760",
    "_runAgentPrompt": "f35102b17c1e8b8a644a801cdef360fc03e0c4ddb93e624c2a160f60cfcbe58f",
    "abort": "d160a170616feb178fc5e56c746973431a83d9745bc4f84d7695ea8b2c8659f9",
    "dispose": "6a886e6a47dc44bf84729dd4d5008354c7b22bc9726b5098c38d8b7c000579b5",
    "_bindExtensionCore": "115993791ee389124260fb6f96f0f91eb4aa1a454a29c428f1a5100249542480",
    "isIdle": "8b15dae6565243906d56ac860e224b6316c665306ecf714922a85d15b3d925e3",
    "isStreaming": "43601ab749b1a83f83239ded83b17af1b9f8053feb7c655640ecb20fc43fddef"
  }
};
// The captured 0.86.1 Linux and Darwin method bodies match byte for byte.
// Keep platform-specific identities; native qualification is recorded separately.
export const MANAGED_0861_PROFILES: readonly ManagedWakeProfile[] = ["linux", "darwin"].map(platform => ({
  id: `managed-${platform}-0.86.1-20260922-r1`, platform: platform as NodeJS.Platform,
  ...{
  "version": "0.86.1",
  "boundHashes": {
    "emitInput": "526809563c9483608cc254baf5f8b7b22ff29674ecee4002e49a12ce5431c0fe",
    "emitBeforeAgentStart": "77256f355f4c9f547b2e6bb0b429cdc68373c0e15abb5d956f98d6b1e134a231",
    "checkAuth": "2b35dec51cdb92924b4fa8e0ec87d21aeb5beb46ec60973d672a7c07c27a132a"
  },
  "hashes": {
    "prompt": "65ed315034309c0b7149c4be8344e9342d3b152f522d8a0dd428cfdda1e2b346",
    "sendCustomMessage": "d19d66c8efb8adb2d2d9f8ef9b3e9a09fe9fd57e52600fd6b7f88fe36f56c760",
    "_runAgentPrompt": "72e9dd4d9bcfab7b296ca895a76f0a7732429df3f6d0ea4b7e04036a5febb9c4",
    "abort": "4a6f26066f883dd7e395b7915285db0edafb7868c1a0e42054a775af4c43bdb2",
    "dispose": "56d6a5c0cb04e3a6fe0ab375fe18e74f79127e761a8dcd71f3d62957829d5c5e",
    "_bindExtensionCore": "6c14c480a6fd9ae17badcea4ae5acfa2bdee47e646933061a55b585b4c6ad0e7",
    "isIdle": "8b15dae6565243906d56ac860e224b6316c665306ecf714922a85d15b3d925e3",
    "isStreaming": "43601ab749b1a83f83239ded83b17af1b9f8053feb7c655640ecb20fc43fddef",
    "_checkCompaction": "aa37a8eadc01a7d3fd782d074955cd9ca6586fa7de7ec02cea7f79329bbf2503",
    "_tryExecuteExtensionCommand": "3d0a9548310a8ff4ecf35c9769d6578c346b1e7df922bbdccf64ac66310e7194"
  }
}
}));
// Captured from the managed OnDemand executable; other builds fail closed.
export const MANAGED_130_PROFILE: ManagedWakeProfile = {
  "version": "1.3.0",
  "platform": "linux",
  "hashes": {
    "prompt": "7f2a642ec61d239f6a4b76e9d5d51ee190f8a15a60f3162518871210425bbfc6",
    "sendCustomMessage": "46b9241d9a201b16d0d384ed975569ad0846efd97c996a5e971f7efa7437c41e",
    "_startRun": "87114fef283c233a372ec1222421f1bfdd2ffc5a6728ef8091a4cd6a2ab4a15b",
    "_prepareRun": "1a4902775431f87fceccf099cac14de8109950268e8ecf3e034b80996878c14d",
    "_normalizePromptImages": "fc8f304eb12d57a33e91d8f1e51fb14d0912d0d96704ca34afc6cb9da8e62886",
    "abort": "032d386557d4cffd0dd069b7937e5efb5292eafb5d6b223e58056681b8535c4b",
    "dispose": "56d6a5c0cb04e3a6fe0ab375fe18e74f79127e761a8dcd71f3d62957829d5c5e",
    "_bindExtensionCore": "5f930ca8d87d77fba01670bb2d5a170baf4792113108b83446bcad0ec21e5d1c",
    "isIdle": "8b15dae6565243906d56ac860e224b6316c665306ecf714922a85d15b3d925e3",
    "isStreaming": "43601ab749b1a83f83239ded83b17af1b9f8053feb7c655640ecb20fc43fddef",
    "_checkCompaction": "59a149e0783b9a2408a8c8e05e42392cdbacc847d725a9fedca7bb2d6538a9f8",
    "_tryExecuteExtensionCommand": "3a9de009edcf3ff51c3f79466258e0240721f1ac8e2977acd5347c55f47fab27"
  },
  "boundHashes": {
    "emitInput": "526809563c9483608cc254baf5f8b7b22ff29674ecee4002e49a12ce5431c0fe",
    "emitBeforeAgentStart": "f5cd7c614941d78dbadb6d7b8f347a1cfffea96e9e2c8febc8e4e5f924faeba6",
    "checkAuth": "2b35dec51cdb92924b4fa8e0ec87d21aeb5beb46ec60973d672a7c07c27a132a"
  },
  "id": "managed-linux-1.3.0-20261020-r1"
};
// Captured through the normal managed Mac launcher; unknown builds fail closed.
export const MANAGED_140_PROFILE: ManagedWakeProfile = {
  "version": "1.4.0",
  "platform": "darwin",
  "hashes": {
    "prompt": "7f2a642ec61d239f6a4b76e9d5d51ee190f8a15a60f3162518871210425bbfc6",
    "sendCustomMessage": "46b9241d9a201b16d0d384ed975569ad0846efd97c996a5e971f7efa7437c41e",
    "abort": "032d386557d4cffd0dd069b7937e5efb5292eafb5d6b223e58056681b8535c4b",
    "dispose": "56d6a5c0cb04e3a6fe0ab375fe18e74f79127e761a8dcd71f3d62957829d5c5e",
    "_bindExtensionCore": "1ca744d72f238fc1b55fcd5c54ad0f9bac75505c142de384dcc00fbd423eb4fd",
    "isIdle": "8b15dae6565243906d56ac860e224b6316c665306ecf714922a85d15b3d925e3",
    "isStreaming": "43601ab749b1a83f83239ded83b17af1b9f8053feb7c655640ecb20fc43fddef",
    "_checkCompaction": "a2b8a58c9e399ea216f26ed59fa877cd69e5cca7b26039defb4c3468de3a3c56",
    "_tryExecuteExtensionCommand": "3a9de009edcf3ff51c3f79466258e0240721f1ac8e2977acd5347c55f47fab27",
    "_startRun": "87114fef283c233a372ec1222421f1bfdd2ffc5a6728ef8091a4cd6a2ab4a15b",
    "_prepareRun": "1a4902775431f87fceccf099cac14de8109950268e8ecf3e034b80996878c14d",
    "_normalizePromptImages": "fc8f304eb12d57a33e91d8f1e51fb14d0912d0d96704ca34afc6cb9da8e62886",
    "_emitAgentSettled": "ed62b164dce0b8ef41e40efa9ba3ef05e38e4da535e2fb4087d357ea5a64cd99",
    "_resolveIdleWaitIfIdle": "18601fb6d540f1fea699e94cfcc51c805eae853dfabcc40b1b1aeb2c8648a75d"
  },
  "boundHashes": {
    "emitInput": "526809563c9483608cc254baf5f8b7b22ff29674ecee4002e49a12ce5431c0fe",
    "emitBeforeAgentStart": "f5cd7c614941d78dbadb6d7b8f347a1cfffea96e9e2c8febc8e4e5f924faeba6",
    "checkAuth": "2b35dec51cdb92924b4fa8e0ec87d21aeb5beb46ec60973d672a7c07c27a132a"
  },
  "id": "managed-darwin-1.4.0-20261026-r2"
};
export function managedWakeProfile(version: string, platform: NodeJS.Platform = process.platform): ManagedWakeProfile | undefined {
  return [MANAGED_0851_PROFILE, ...MANAGED_0861_PROFILES, MANAGED_130_PROFILE, MANAGED_140_PROFILE].find(profile => profile.version === version && profile.platform === platform);
}
type Token = { session: any; state: State; epoch: number; identity: string; release(): void; accept?(): void; rejected?: boolean; started?: boolean; command?: boolean; settledRequests?: Array<{ kind: "prompt" | "custom"; args: any[] }> };
type State = { epoch: number; disposed: boolean; gate?: Promise<void>; release?: () => void; wake?: Promise<unknown>; ids: Set<string>; guardAttempted?: boolean; guards?: Array<{ target: any; name: string; fn: Function }> };
export type ManagedWakeAdapter = { status: "installed" | "unsupported"; profile?: string; qualification?: ManagedWakeProfile; reason?: string; supports(context: unknown): boolean; request(context: unknown, request: WakeRequest): WakeReceipt };
const INSTALLED = Symbol.for("pi.harness.health.managed-wake.adapter.v1");
const digest = (fn: Function) => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");

/** No profile is inferred from version alone. Call only after explicit opt-in. */
export function installManagedWake(AgentSession: any, version: string, profile: ManagedWakeProfile | undefined = managedWakeProfile(version)): ManagedWakeAdapter {
  const unsupported = (reason: string): ManagedWakeAdapter => ({ status: "unsupported", reason, supports: () => false, request: (_ctx, req) => ({ id: req.id, status: "unsupported" }) });
  const prototype = AgentSession?.prototype;
  if (!prototype || !profile || (profile.platform && profile.platform !== process.platform) || profile.version !== version || !["0.85.1", "0.86.1", "1.3.0", "1.4.0"].includes(version)) return unsupported("No qualified runtime profile");
  const prior = prototype[INSTALLED] as ManagedWakeAdapter | undefined;
  if (prior) return prior.profile === profile.id ? prior : unsupported("Another wake adapter profile is installed");
  const modern = ["1.3.0", "1.4.0"].includes(version);
  const cleanup = version === "1.4.0";
  const descriptors = new Map<string, PropertyDescriptor>();
  const originals: Record<string, Function> = {};
  for (const name of [...(modern ? QUALIFIED_METHODS : LEGACY_QUALIFIED_METHODS), ...(cleanup ? CLEANUP_METHODS : [])]) {
    const desc = Object.getOwnPropertyDescriptor(prototype, name);
    const fn = desc?.value ?? desc?.get;
    if (typeof fn !== "function" || digest(fn) !== profile.hashes[name] || !desc?.configurable) return unsupported(`Unqualified runtime method: ${name}`);
    descriptors.set(name, desc); originals[name] = fn;
  }
  if (!Object.isExtensible(prototype)) return unsupported("Runtime prototype is not extensible");
  const states = new WeakMap<object, State>();
  const sessions = new WeakMap<object, any>();
  const ownership = new AsyncLocalStorage<Token>();
  function track(session: any): State {
    let state = states.get(session);
    if (!state) { state = { epoch: 0, disposed: false, ids: new Set() }; states.set(session, state); }
    if (session.sessionManager && typeof session.sessionManager === "object") sessions.set(session.sessionManager, session);
    return state;
  }
  const guardedFunctions = new WeakMap<Function, Function>();
  function guardedAwait(fn: Function): Function {
    return function (this: any, ...args: any[]) {
      const token = ownership.getStore();
      if (token && !token.started && !valid(token)) throw new Error("Session changed or input interrupted during preflight");
      const result = fn.apply(this, args);
      // Model/tool operations after admission keep their native behavior. In
      // particular, a parent turn's abort must not cancel unrelated SDK work
      // merely because it inherited that turn's async context.
      if (!token || token.started) return result;
      return Promise.resolve(result).then(value => {
        if (!token.started && !valid(token)) throw new Error("Session changed or input interrupted during preflight");
        return value;
      });
    };
  }
  function bindGuards(session: any, runner: any) {
    const state = track(session);
    state.guardAttempted = true;
    const targets = [{ target: runner, name: "emitInput" }, { target: runner, name: "emitBeforeAgentStart" }, { target: session._modelRuntime, name: "checkAuth" }];
    if (targets.some(({ target, name }) => typeof target?.[name] !== "function" || digest(guardedFunctions.get(target[name]) ?? target[name]) !== profile!.boundHashes[name as keyof ManagedWakeProfile["boundHashes"]])) { state.guards = undefined; return; }
    const changed: Array<{ target: any; name: string; descriptor?: PropertyDescriptor }> = [];
    try {
      state.guards = targets.map(({ target, name }) => {
        let fn = target[name];
        if (!guardedFunctions.has(fn)) {
          const original = fn; fn = guardedAwait(fn); guardedFunctions.set(fn, original);
          const descriptor = Object.getOwnPropertyDescriptor(target, name);
          target[name] = fn; changed.push({ target, name, descriptor });
        }
        return { target, name, fn };
      });
    } catch {
      for (const { target, name, descriptor } of changed.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name];
      }
      state.guards = undefined;
    }
  }
  const valid = (token: Token) => !token.state.disposed && token.state.epoch === token.epoch && token.session.sessionManager.getSessionId() === token.identity;
  async function admit(session: any, kind: "prompt" | "custom", args: any[]) {
    const state = track(session); const identity = session.sessionManager.getSessionId();
    // session_start can install after native binding. Qualify that existing
    // instance once on first admission; never bless later arbitrary drift.
    if (!state.guardAttempted) bindGuards(session, session._extensionRunner);
    if (!state.guards?.every(g => g.target[g.name] === g.fn)) return originals[kind === "prompt" ? "prompt" : "sendCustomMessage"].apply(session, args);
    const current = ownership.getStore();
    if (cleanup && state.gate && current && current.session === session && session._isEmittingAgentSettled) {
      // Match native turn deferral, then drain only after context restoration
      // and the cancelled preparation's admission gate have both settled.
      (current.settledRequests ??= []).push({ kind, args });
      return;
    }
    if (state.gate && current && current.session === session && current.release === state.release && current.command) current.release();
    if (state.gate && current && current.session === session && current.release === state.release) {
      throw new Error("Cannot start inference reentrantly during prompt preflight. Return from the command or input hook before starting another turn, or use nextTurn delivery.");
    }
    let waited = false;
    while (state.gate) { waited = true; await state.gate; }
    if (state.disposed || identity !== session.sessionManager.getSessionId()) {
      if (kind === "prompt" && !modern) args[1]?.preflightResult?.(false);
      throw new Error("Session changed before queued input submission");
    }
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }); state.gate = gate;
    const release = () => { if (state.gate === gate) { state.gate = undefined; state.release = undefined; } unlock(); };
    state.release = release;
    const token: Token = { session, state, identity, epoch: state.epoch, release };
    // Native prompt moves this array into its prospective messages before
    // before_agent_start. Retain the reference so an aborted preflight cannot
    // silently consume context that was never submitted to the agent.
    const nextTurn = kind === "prompt" || modern ? session._pendingNextTurnMessages : undefined;
    let pendingAccepted = false; let callbackDone = false;
    const callback = kind === "prompt" ? args[1]?.preflightResult : undefined;
    const acknowledge = (accepted: boolean | string) => { if (!callbackDone) { callbackDone = true; callback?.(accepted); } };
    if (kind === "prompt") {
      const options = args[1] ?? {};
      args = [args[0], { ...options,
        streamingBehavior: options.streamingBehavior ?? ((waited || state.wake) ? "followUp" : undefined),
        preflightResult: (accepted: boolean | string) => { if (modern) acknowledge(accepted); else if (accepted) pendingAccepted = true; else acknowledge(false); },
      }];
      token.accept = () => { if (pendingAccepted) acknowledge(true); };
    }
    try {
      return await ownership.run(token, () => originals[kind === "prompt" ? "prompt" : "sendCustomMessage"].apply(session, args));
    } catch (error) {
      if (!token.started && !state.disposed && identity === session.sessionManager.getSessionId() && state.epoch !== token.epoch && Array.isArray(nextTurn) && Array.isArray(session._pendingNextTurnMessages) && nextTurn !== session._pendingNextTurnMessages) {
        session._pendingNextTurnMessages = [...nextTurn, ...session._pendingNextTurnMessages.filter((message: unknown) => !nextTurn.includes(message))];
      }
      if (!modern) acknowledge(false);
      throw error;
    }
    finally {
      if (pendingAccepted && !token.rejected) acknowledge(true);
      release();
      for (const request of token.settledRequests ?? []) {
        void ownership.exit(() => admit(session, request.kind, request.args)).catch(error => {
          try { session._extensionRunner.emitError({ extensionPath: "<runtime>", event: "send_message", error: String(error) }); }
          catch { /* Native diagnostic failure does not change settled admission. */ }
        });
      }
    }
  }
  const methods: Record<string, Function> = {
    prompt: function (this: any, ...args: any[]) { return admit(this, "prompt", args); },
    sendCustomMessage: function (this: any, ...args: any[]) {
      return args[1]?.triggerTurn && args[1]?.deliverAs !== "nextTurn" ? admit(this, "custom", args) : originals.sendCustomMessage.apply(this, args);
    },
    _runAgentPrompt: function (this: any, ...args: any[]) {
      const token = ownership.getStore();
      if (token && token.session === this) {
        if (!valid(token)) { token.rejected = true; throw new Error("Session changed or input interrupted during preflight"); }
        token.accept?.();
        token.started = true;
      }
      // Qualified original sets its running flag synchronously before returning.
      // Promise waiters cannot run until after this call has made that visible.
      const result = originals._runAgentPrompt.apply(this, args);
      if (token && token.session === this) token.release();
      return result;
    },
    // Retain the preflight gate until the native method settles. Releasing it
    // early would let an old auth/input hook mutate queues concurrently with a
    // new submission. Indefinitely hung preflight is detected, not repaired.
    abort: function (this: any, ...args: any[]) { const s = track(this); s.epoch++; s.wake = undefined; return originals.abort.apply(this, args); },
    dispose: function (this: any, ...args: any[]) { const s = track(this); s.disposed = true; s.epoch++; s.wake = undefined; s.release?.(); return originals.dispose.apply(this, args); },
    _checkCompaction: guardedAwait(originals._checkCompaction),
    _tryExecuteExtensionCommand: async function (this: any, ...args: any[]) {
      const token = ownership.getStore();
      if (token && token.session === this) token.command = true;
      try {
        const handled = await originals._tryExecuteExtensionCommand.apply(this, args);
        // A handled command may intentionally switch sessions. An unknown
        // command falls through to model preflight and must retain ownership.
        if (!handled && token && token.session === this && !valid(token)) throw new Error("Session changed or input interrupted during preflight");
        return handled;
      }
      finally { if (token && token.session === this) token.command = false; }
    },
    _bindExtensionCore: function (this: any, ...args: any[]) { bindGuards(this, args[0]); return originals._bindExtensionCore.apply(this, args); },
  };
  if (modern) {
    delete methods._runAgentPrompt;
    methods._prepareRun = guardedAwait(originals._prepareRun);
    methods._normalizePromptImages = guardedAwait(originals._normalizePromptImages);
    methods._startRun = async function (this: any, trigger: any, onStarted?: () => void) {
      const token = ownership.getStore();
      if (token && token.session === this && !valid(token)) throw new Error("Session changed or input interrupted during preflight");
      let rejectedAfterPreparation = false;
      try {
        // Keep admission until native preparation and synchronous message
        // subscribers finish. Its onStarted callback lies outside native cleanup.
        return await originals._startRun.call(this, trigger, () => {
          if (token && token.session === this) {
            if (!valid(token)) {
              token.rejected = true;
              rejectedAfterPreparation = true;
              throw new Error("Session changed or input interrupted during preflight");
            }
            token.started = true;
            token.release();
          }
          onStarted?.();
        });
      } catch (error) {
        if (cleanup && rejectedAfterPreparation) {
          // No agent request was admitted. Clear this prepared run and flush
          // passive messages before using captured native settlement.
          this._isAgentRunActive = false;
          this._runSystemPromptOptions = undefined;
          this._agentRunAbortRequested = true;
          try { this._flushPendingBashMessages(); this._flushPendingCustomMessages(); await originals._emitAgentSettled.call(this); }
          catch (settlement) { throw new AggregateError([error, settlement], `Interrupted startup settlement failed: ${error instanceof Error ? error.message : String(error)}`); }
          finally { originals._resolveIdleWaitIfIdle.call(this); }
        }
        throw error;
      }
    };
  }
  const qualifiedDispatch = (session: any) => session._bashAbortControllers instanceof Set && !!states.get(session)?.guards?.every(g => g.target[g.name] === g.fn) && Object.getPrototypeOf(session) === prototype
    && Object.entries(methods).every(([name, fn]) => session[name] === fn)
    && (!cleanup || CLEANUP_METHODS.every(name => session[name] === originals[name]))
    && ["isIdle", "isStreaming"].every(name => !Object.hasOwn(session, name) && Object.getOwnPropertyDescriptor(prototype, name)?.get === originals[name]);
  const adapter: ManagedWakeAdapter = {
    status: "installed", profile: profile.id,
    qualification: Object.freeze({ ...profile, boundHashes: Object.freeze({ ...profile.boundHashes }), hashes: Object.freeze({ ...profile.hashes }) }),
    supports(context) {
      try {
        const manager = (context as any)?.sessionManager;
        const session = manager && typeof manager === "object" ? sessions.get(manager) : undefined;
        return !!session && !states.get(session)?.disposed && qualifiedDispatch(session);
      } catch { return false; }
    },
    request(context, req) {
      const receipt = (status: WakeReceipt["status"]): WakeReceipt => ({ id: req.id, status });
      let manager: any;
      try { manager = (context as any)?.sessionManager; } catch { return receipt("stale"); }
      const session = manager && typeof manager === "object" ? sessions.get(manager) : undefined;
      if (!session) return receipt("unsupported");
      // Another extension may replace methods after installation. A receipt
      // must never promise safe wake through a now-unqualified dispatch path.
      if (!qualifiedDispatch(session)) return receipt("unsupported");
      const state = track(session);
      if (state.disposed || req.sessionId !== manager.getSessionId()) return receipt("stale");
      if (typeof req.id !== "string" || !req.id || req.id.length > 200 || typeof req.content !== "string" || !req.content.trim() || req.content.length > 16000) return receipt("invalid");
      if (state.ids.has(req.id)) return receipt("duplicate");
      // Native isIdle excludes interactive !bash commands; these also own user attention.
      if (state.gate || state.wake || !session.isIdle || session._bashAbortControllers.size > 0) return receipt("busy");
      state.ids.add(req.id); if (state.ids.size > 256) state.ids.delete(state.ids.values().next().value!);
      const run = session.prompt(req.content, { expandPromptTemplates: false, source: "extension" }) as Promise<unknown>;
      state.wake = run;
      void run.catch(() => { /* Missing start acknowledgment is diagnosed by monitor. */ }).finally(() => { if (state.wake === run) state.wake = undefined; });
      return receipt("accepted");
    },
  };
  // Prevalidated descriptors are ordinary configurable class methods. Roll back
  // on unexpected installation failure rather than leave a partial adapter.
  const changed: string[] = [];
  try {
    for (const [name, value] of Object.entries(methods)) { Object.defineProperty(prototype, name, { ...descriptors.get(name), value }); changed.push(name); }
    Object.defineProperty(prototype, INSTALLED, { value: adapter, configurable: true });
  } catch {
    for (const name of changed) Object.defineProperty(prototype, name, descriptors.get(name)!);
    return unsupported("Runtime adapter installation failed");
  }
  return adapter;
}
