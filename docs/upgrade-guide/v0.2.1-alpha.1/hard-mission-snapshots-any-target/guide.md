---
kind: upgrade-guide
description: "The hard mission pins any target through a harness-owned snapshot, so the armed commit is the snapshot's and target.commit only checks HEAD."
---

# Hard mission pins any target through a snapshot

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, `hard-mission` required a git repository: it resolved `target.commit` (default `HEAD`) to a sha of the target's own git and read the matrix and every citation from that commit. A plain directory or a single file failed the load.

The next release captures every target into a git store the harness owns:

- `target.repoPath` may name a git repository, a plain directory, or one file such as a shared library. Arming captures it into `<target.snapshotRoot>/store.git`; the hard bundle sets `snapshotRoot` to `hard/snapshots` under the DSH home. Nothing is written inside the target.
- A git target contributes its tracked files plus the untracked files its ignore rules keep, with working-tree content, so local changes are captured instead of ignored. A plain directory contributes every file its ignore files keep.
- `hard/mission/armed` records the snapshot commit in `commit` and adds `snapshot` with the store, the target kind, and, for a git target, its HEAD as `origin.commit` with a `dirty` flag.
- `target.commit` has no default. When set, it only checks that a git target has that commit checked out; on any other target it fails the load.
- The `DEFAULT_TARGET_COMMIT` export is gone.

## Migration

1. Remove `commit: HEAD` from profile patches whose target is not a git repository; it is redundant for git targets.
2. Read the target's own commit from `snapshot.origin.commit`, not `commit`, in tools that compare runs against the repository's history.
3. Keep room for the snapshot store: it holds a compressed copy of each captured target, and identical files share storage across targets.
4. Confirm: the session's `hard/mission/armed` event carries `snapshot`, and `git --git-dir=<snapshot.gitDir> ls-tree -r <commit>` lists what the matrix enumerates.
