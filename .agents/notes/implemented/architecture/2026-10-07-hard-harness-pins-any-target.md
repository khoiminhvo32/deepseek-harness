# Agent Note: The hard harness pins any target through its own snapshot

Status: implemented

English | [中文](2026-10-07-hard-harness-pins-any-target.zh.md)

## Problem

The hard harness must audit whatever it is given: a git repository, a directory of sources without git, or a single shared library. Arming pinned a commit of the target's own git, so anything that was not a git repository failed the load, and the first arming refused a working tree that differed from the commit.

Sharing the live target also broke the independent reader. In the second pilot, all three readers opened the mission agent's PoCs under the target's untracked `poc/` directory, which carry its finding claims; one reader cited a PoC by name in its verdict. The contamination check accepted every read inside the target, so none of the three was voided.

## Decision

- **The pinned commit is a snapshot the harness owns.** At load, `hard-mission` captures the target into `<target.snapshotRoot>/store.git`, a git directory outside the target (`hard/snapshots` under the DSH home by default), through a private index per capture. A git work tree contributes its tracked files plus the untracked files its ignore rules keep, with working-tree content; a plain directory contributes every file its ignore files keep; a single file contributes itself. The harness's state directories and the target's `.git` never enter, and nothing is written inside the target. A fixed identity and time make the commit a function of the content, so one store serves every target and a ref keeps each snapshot commit alive.
- **The arming record names the snapshot.** `hard/mission/armed` keeps the snapshot commit in `commit` and adds `snapshot`: the store, the target kind, and for a git target its HEAD and whether the work tree differed. `pinnedGitArgs` turns that into the git arguments every reader of the pinned content uses; records without a snapshot keep reading the target's own git.
- **The snapshot is what the model saw.** Uncommitted changes are captured instead of refused, and files the model writes later stay outside the snapshot. `target.commit` survives only as an optional check that a git target has that commit checked out.
- **The reader reads a worktree of the snapshot.** Before each read, `hard-audit` checks the pinned commit out into a fresh temporary worktree and starts the reader there through a new `cwd` option of the subagent seam, which the spawn provider supports and other providers refuse. Any read outside the worktree, other than the reader's own spill file, is contamination. The before-and-after drift checks are gone, because the worktree cannot drift.

## Alternatives considered

- **Keep requiring a git repository.** Rejected: the harness must accept a decompiled tree, a release tarball, or a single binary as readily as a repository.
- **Refuse a drifted working tree at the first arming.** Replaced: it protected the commit from content the model never saw, which the snapshot achieves by capturing exactly what the model sees.
- **Move PoCs outside the target.** Rejected: the PoC contract runs PoCs from the target root, and the reader would still share every later edit of the live tree.
- **One store per target path.** Rejected: a key derived from the path differs between machines and temporary directories, while the content-addressed commit does not.
- **A read-confining filesystem for the reader.** Still deferred: with a pristine worktree, a read outside it is detectable as a path, which the shadow measurement only needs to void.

## Consequences

- Plain directories and single files arm; a single binary is one unscreened row until a binary track splits it by symbol.
- Every load captures the target again, and the store grows with each distinct snapshot; identical files are stored once.
- The independent reader sees exactly the armed content, and its contamination rule shrinks to one root.
- The subagent seam gains a capability whose absence is the default, so existing providers need no change.

## Related

This note supersedes the drift-refusal decision of [the hard harness judges claims, not code](2026-10-07-hard-harness-judges-claims-not-code.md), whose other decisions stand.
