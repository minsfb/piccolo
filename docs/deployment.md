# Remote deployment

Piccolo uses explicit hosts and externally supplied transport commands. The remote
host must already have compatible Pi, Node, dependencies, provider authentication,
and the target checkout. Piccolo does not copy credentials or configure SSH.

```toml
[hosts.worker]
hostname = "worker.example.com"
cwd = "/home/user/project"
transport = ["ssh", "user@worker.example.com"]
```

Inspect your selected host and execution policy before launching work:

```sh
piccolo remote start --host worker --cwd /path/to/project --task-file task.txt --model provider/model
piccolo remote status --host worker --cwd /path/to/project --id JOB_UUID
```

The native detached runner and Durable service have separate lifetime and storage
contracts. Use [Durable workers](durable-workers.md) for independent retained
workers and [session jobs](session-jobs.md) for parent-owned SDK work. External
supervision owns process restart and transport recovery. Retained records must
be reconciled before replaying ambiguous operations.
