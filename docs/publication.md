# Public source scope

This repository publishes the portable Pi package and generic configuration.
Machine provisioning, provider authentication, organization policy modules,
private research, live deployment records, and raw execution captures are outside
its distribution.

Before publishing a revision, audit tracked source and all newly reachable Git
history for credentials, private links, identities, package names, proprietary
code, and restricted assets. Check the lockfile's registry origins and dependency
licenses. Export only the reviewed branch, with an explicit destination and a
verified remote receipt; avoid automatic tags and unrelated refs.

The initial publication uses a fresh history. Later publications should build on
the public branch and preserve that boundary. Run the documented regression,
type, syntax, and whitespace checks. Live qualification is a separately authorized
operation; this distribution makes no claim about a user's deployment.

The package retains `UNLICENSED` metadata and `private: true`. Git publication
adds neither a software license nor npm publication authority.
