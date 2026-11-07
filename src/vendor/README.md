# Git placement helper

`git-worktree.mjs` is the portable helper owned by envy's
`assets/agent-assets/skills/implement/scripts/git-worktree.mjs`. It is distributed
here as an exact copy so Piccolo remains independently installable. The helper
uses only Node's standard library and Git, and requires no envy installation.
Do not edit the copy independently.

Canonical source: envy commit `f6440deabc4a87e8ee894aeb4f0d49745997a725`.
Module SHA-256: `adf788e39bc4be41a7723ce08af65829045bf27a8e41f48c2c0d37898de0e8e7`.

Update/check it using:

```sh
node scripts/sync-worktree-helper.mjs --source /path/to/envy/assets/agent-assets/skills/implement/scripts/git-worktree.mjs
node scripts/sync-worktree-helper.mjs --source /path/to/envy/assets/agent-assets/skills/implement/scripts/git-worktree.mjs --check
```

The declarations are Piccolo's TypeScript adapter. Root resolution, ignore
preparation and nesting rejection remain owned by the shared module.
