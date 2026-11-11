# Git placement helper

`git-worktree.mjs` is the portable helper owned by envy's
`assets/agent-assets/skills/implement/scripts/git-worktree.mjs`. It is distributed
here as an exact copy so Piccolo remains independently installable. The helper
uses only Node's standard library and Git, and requires no envy installation.
Do not edit the copy independently.

Canonical source: [envy commit `0b500f1`](https://github.com/minsfb/envy/commit/0b500f1b25644e3adc5326dd6fafef0c70df628b).
Module SHA-256: `5adfb53cde0da9349066e38e30a470c73b68b183d8621703ed5e420afed2615a`.

Update/check it using:

```sh
node scripts/sync-worktree-helper.mjs --source /path/to/envy/assets/agent-assets/skills/implement/scripts/git-worktree.mjs
node scripts/sync-worktree-helper.mjs --source /path/to/envy/assets/agent-assets/skills/implement/scripts/git-worktree.mjs --check
```

The declarations are Piccolo's TypeScript adapter. Root resolution, ignore
preparation and nesting rejection remain owned by the shared module.
After synchronization, record the canonical source commit and reported module
digest here before committing the vendored update.
