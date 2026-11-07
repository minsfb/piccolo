import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { managedWakeProfile, installManagedWake } from "../packages/health/src/managed-wake.ts";

test("managed profiles require an enumerated version and platform", () => {
  assert.equal(managedWakeProfile("0.85.1", "linux")?.version, "0.85.1");
  assert.equal(managedWakeProfile("0.85.1", "darwin"), undefined);
  const linux = managedWakeProfile("0.86.1", "linux")!;
  const mac = managedWakeProfile("0.86.1", "darwin")!;
  assert.notEqual(linux.id, mac.id);
  assert.deepEqual(linux.hashes, mac.hashes);
  assert.deepEqual(linux.boundHashes, mac.boundHashes);
  for (const version of ["0.86.0", "0.86.2", "0.86.1-dev", "1.0.0"])
    assert.equal(managedWakeProfile(version, "darwin"), undefined);
  assert.equal(managedWakeProfile("0.86.1", "win32"), undefined);
});

test("matching version cannot bless different SDK method bodies or a foreign platform", () => {
  const before = Object.getOwnPropertyDescriptors(AgentSession.prototype);
  const foreign = process.platform === "linux" ? "darwin" : "linux";
  assert.equal(installManagedWake(AgentSession, "0.86.1", managedWakeProfile("0.86.1", foreign)).status, "unsupported");
  assert.equal(installManagedWake(AgentSession, "0.86.1").status, "unsupported");
  assert.deepEqual(Object.getOwnPropertyDescriptors(AgentSession.prototype), before);
});


test("Pi 1.4 wake requires the captured Darwin profile, not merely a version or SDK match", () => {
  const profile = managedWakeProfile("1.4.0", "darwin")!;
  assert.equal(profile.version, "1.4.0");
  assert.equal(profile.platform, "darwin");
  assert.equal(managedWakeProfile("1.4.0", "linux"), undefined);
  assert.equal(managedWakeProfile("1.4.1", "darwin"), undefined);
  const before = Object.getOwnPropertyDescriptors(AgentSession.prototype);
  assert.equal(installManagedWake(AgentSession, "1.4.0", profile).status, "unsupported");
  assert.deepEqual(Object.getOwnPropertyDescriptors(AgentSession.prototype), before);
});
