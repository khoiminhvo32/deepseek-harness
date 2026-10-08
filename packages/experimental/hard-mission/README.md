---
description: "The hard-mission plugin for deployments running one long-lived objective that the session must keep working toward."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-mission` arms the configured objective as a durable session goal, pins the target — a git repository, a plain directory, or one file — in a harness-owned snapshot, and registers the `hard:mission` system-prompt section that teaches the mission contract: keep working across turns, alternate systematic and deep-reading passes, route completion through the goal tools, and make every PoC fail under a benign payload. Arming enumerates every snapshot file into the coverage matrix and appends `hard/mission/armed` once for each fresh root agent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service when a deployment owns one long-lived objective, such as continuous vulnerability research over a pinned target repository. The objective and the target are required; a blank objective, a relative `target.repoPath`, or a path that does not exist fails the load.

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
    target:
      repoPath: /abs/path/to/target   # a git repository, a plain directory, or one file
      moduleDepth: 2
      excludeGlobs: []   # empty by default; an exclusion is recorded and reported
```

`target.repoPath` is required and must be absolute. At load the plugin captures the target into the snapshot store `<target.snapshotRoot>/store.git`, a git directory the harness owns outside the target (`hard/snapshots` under the DSH home by default; the hard bundle sets it the same way). A git target contributes its tracked files plus the untracked files its ignore rules keep, with working-tree content; a plain directory contributes every file its ignore files keep; a single file contributes itself, and its directory becomes the work tree PoCs run in. The harness's own state directories and the target's `.git` never enter, and nothing is written inside the target. The snapshot commit uses a fixed identity and time, so the same content always pins the same commit, and a ref keeps every snapshot commit alive. The armed event records it in `commit` and adds `snapshot` (the store, the target kind, and for a git target its HEAD as `origin.commit` with a `dirty` flag); ignored entries are counted into `ignoredEntryCount`. `target.commit` is optional: when set, a git target must have that commit checked out, and any other target fails the load. The plugin lists the snapshot's files — a numstat diff of its tree against the empty tree, which also marks binary content — and filters them through `target.excludeGlobs` (root-anchored globs, empty by default) and groups the survivors by their first `target.moduleDepth` (default 2) directory segments; a repository-root file becomes the module `.`. Zero surviving modules or more than 500 modules fail the load; in the latter case lower `moduleDepth` so modules group coarser — the harness never advises dropping code to fit. The result is sorted and deduplicated, so re-arming over the same commit reproduces the identical matrix, and the ledger serves it as the coverage denominator.

Nothing is excluded by default: vendored libraries, built bundles, and translation catalogs ship to production too, so the harness audits every file the snapshot holds. An exclusion is the deployment's explicit decision, and the armed event records it — the applied globs, the excluded tracked-file count, and a bounded sample — so the report and the panel state what the coverage ratio leaves out. **Auditing a large `vendor/` tree multiplies the cost of a mission;** excluding it is a legitimate choice, but never a silent one.

After grouping, every module whose every tracked file carries one of the inert extensions (`.md`, `.markdown`, `.txt`, `.rst`, and the raster and font binaries) is recorded in the armed event's `inertModules` and needs no module-class coverage. The list is deliberately conservative: an unknown extension counts as code, `.svg` stays code (it can carry `<script>`), configuration and template formats stay code, gettext catalogs stay code (a translation echoed unescaped into a page is an XSS vector), and extensionless files (Dockerfile, Makefile) stay code — so the screen can only under-screen, never dismiss a module that holds a surface. When every module screens inert the load fails: `target has no code modules`.

Every non-inert module that holds a tracked binary — whatever its extension, because the cross-check's `grep -I` skips binary content — or a tracked file whose extension the verifier's fixed pattern tables were not written for (`SCREENED_EXTENSIONS`: the JavaScript and TypeScript family, Python, Java, and PHP) is recorded in `unscreenedModules`. The cross-check grep is silent on such a module, so it neither re-opens nor supports a clear there: a batch clear is refused, and the model's own clear stands as a blind clear that the report and the panel count.

The snapshot is what the model saw when the mission armed. Files the model writes later — PoCs, edits — stay outside it, so citations and the independent reader keep resolving against the armed content. A load re-captures the target, but a resumed session keeps the commit its arming recorded.

`bugClasses` defaults to the systematic-pass list of every OWASP Top 10 class with mechanical source-to-sink semantics (sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race); an empty list removes the class list from the contract. Insecure design and security logging have no mechanical source-sink pair and stay in the deep-reading pass. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-mission) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Arming at creation.** The plugin listens on `agent/created` and arms a goal through `ctx.goals.create` only when the source is `startup`, the agent is a registry root, and no goal is current. Every other source, child agent, or existing goal is left untouched, so the goal service's restore-and-disarm policy for persisted sessions stays authoritative.
- **Target pinning at load.** Before any agent exists, `apply` captures the target into the snapshot store and enumerates the coverage matrix through the shell seam, with the developer's global git configuration, external diff drivers, and textconv off, and with a private index per capture so concurrent missions share only the content-addressed store. Commands that write run under a `workspace-write` sandbox rooted at the snapshot root, so the capture works under any session sandbox and can write nowhere else; the `status` read of a git target takes no lock. A misconfigured target — a missing path, a `target.commit` that is not checked out, no surviving module, or an oversized matrix — fails the load instead of arming a mission without a denominator. The matrix rides the additive `hard/mission/armed` session event the ledger folds.
- **One contract section.** The `hard:mission` section renders the objective, the systematic-pass class list, and the deep-reading cadence from the resolved config. It is static text: it changes only when the deployment configuration changes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, contract rendering, section registration, startup arming, target pinning |
| [`src/modules.ts`](src/modules.ts) | Pure module grouping, exclusion-glob filtering, and the inert and unscreened classifications over tracked paths |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

One fixed mission contract whose objective, bug-class list, and deep-reading cadence are interpolated from the deployment configuration. The rendered example below uses the configured objective `Find and verify every authentication bypass`, the default class list, and the default cadence.

##### Mission contract

```markdown
Mission: Find and verify every authentication bypass
This session carries one durable goal and keeps working toward it across turns. Do not stop to announce progress while concrete work remains; take the next action instead. Systematic passes sweep these bug classes: sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race. Every 3 systematic passes, run a deep-reading pass that models dataflow, trust boundaries, and state machines to form and test hypotheses beyond pattern matching. Propose completion with update_goal action complete once the objective is genuinely achieved; the harness, not you, certifies it — an early attempt is denied with the exact remaining work, and an empty sweep only counts when it cites a refuted hypothesis or a cell you cleared. Ending a turn does not end the mission.
```

#### Token effect

Small fixed input cost on every request where the section registration is in scope.

#### KV Cache effect

Prefix-stable while the plugin scope and configuration are unchanged. Activation, disposal, or configuration changes may invalidate reuse from this prompt section.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Startup-only arming** — a resumed or cleared session keeps the goal service's restored (disarmed) goal; automatic re-arming on resume and on quota standby wake belongs to the hard-standby plugin.
- **Completion path assumes the goal tools** — the contract names `update_goal action complete`; a composition without `dsh-tool-goal` must surface that action through another consumer.
- **Arming and guidance only** — the mission itself neither vetoes completion nor certifies it; the hard stop gate owns that decision over this matrix, and the armed record carries the `goalId` the gate keys on.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
