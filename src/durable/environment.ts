import { Connection, LocalExecutionEnv, RemoteExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Transport is supplied by the deployment, without provisioning or credential handling. */
export function executionEnvironments(remote?: { command: string[]; identity: string }) {
  const connection = new Connection({ command: remote?.command ?? [localDaemon()] });
  const environments = new Map<string, ExecutionEnv>();
  return {
    get(cwd: string) {
      let env = environments.get(cwd);
      if (!env) {
        env = remote ? new RemoteExecutionEnv({ connection, id: remote.identity, cwd }) : new LocalExecutionEnv({ connection, cwd });
        environments.set(cwd, env);
      }
      return env;
    },
    async close() { await connection.close(); },
  };
}
