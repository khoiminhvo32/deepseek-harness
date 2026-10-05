---
description: "The hard-mission plugin for deployments running one long-lived objective that the session must keep working toward."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-mission` arms the configured objective as a durable session goal, pins the configured target repository, and registers the `hard:mission` system-prompt section that teaches the mission contract: keep working across turns, alternate systematic and deep-reading passes, and declare completion only through the goal tools. Arming resolves the target commit to its full sha, enumerates the tracked modules into the deterministic coverage matrix, screens out modules whose every file carries a non-executable extension, and appends the `hard/mission/armed` session event once. It arms fresh root agents on `startup` only; resumed, cleared, compacted, and child agents keep their own goal state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service when a deployment owns one long-lived objective, such as continuous vulnerability research over a pinned target repository. The objective and the target are required; a blank objective, a relative `target.repoPath`, or a target that is not a git repository fails the load.

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
    target:
      repoPath: /abs/path/to/target-repo
      commit: HEAD
      moduleDepth: 2
      excludeGlobs: ['node_modules/**', 'vendor/**', 'dist/**', 'build/**']
```

`target.repoPath` is required and must be absolute. At load the plugin resolves `target.commit` (default `HEAD`) through `git rev-parse`, lists the tracked files with `git ls-files` — so `.gitignore` is respected for free and the enumeration is tied to the pinned commit — filters them through `target.excludeGlobs` (root-anchored globs), and groups the survivors by their first `target.moduleDepth` (default 2) directory segments; a repository-root file becomes the module `.`. Zero surviving modules or more than 500 modules fail the load; lower `moduleDepth` or exclude more trees in the latter case. The result is sorted and deduplicated, so re-arming over the same commit reproduces the identical matrix, and the ledger serves it as the coverage denominator.

The default `excludeGlobs` also skip the usual non-source trees (`.git`, `docs`, `doc`, `locales`, `i18n`, `assets`, `fixtures`, `testdata`, `__snapshots__`, and minified bundles), but the defaults are a starting point, not a promise: **you must tune `excludeGlobs` to the target repository.** A wrong denominator silently skews both the coverage matrix and every completion decision built on it.

After grouping, every module whose every tracked file carries one of the inert extensions (`.md`, `.markdown`, `.txt`, `.rst`, the raster and font binaries, and the gettext catalogs) is recorded in the armed event's `inertModules` and needs no module-class coverage. The list is deliberately conservative: an unknown extension counts as code, `.svg` stays code (it can carry `<script>`), configuration and template formats stay code, and extensionless files (Dockerfile, Makefile) stay code — so the screen can only under-screen, never dismiss a module that holds a surface. When every module screens inert the load fails: `target has no code modules`.

`bugClasses` defaults to the systematic-pass list of every OWASP Top 10 class with mechanical source-to-sink semantics (sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race); an empty list removes the class list from the contract. Insecure design and security logging have no mechanical source-sink pair and stay in the deep-reading pass. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-mission) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Arming at creation.** The plugin listens on `agent/created` and arms a goal through `ctx.goals.create` only when the source is `startup`, the agent is a registry root, and no goal is current. Every other source, child agent, or existing goal is left untouched, so the goal service's restore-and-disarm policy for persisted sessions stays authoritative.
- **Target pinning at load.** Before any agent exists, `apply` resolves the target commit and enumerates the coverage matrix through the shell seam (`git rev-parse`, then `git ls-files`), so a misconfigured target — missing repository, unresolvable commit, no surviving module, or an oversized matrix — fails the load instead of arming a mission without a denominator. The matrix rides the additive `hard/mission/armed` session event the ledger folds.
- **One contract section.** The `hard:mission` section renders the objective, the systematic-pass class list, and the deep-reading cadence from the resolved config. It is static text: it changes only when the deployment configuration changes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, contract rendering, section registration, startup arming, target pinning |
| [`src/modules.ts`](src/modules.ts) | Pure module grouping and exclusion-glob filtering over tracked paths |

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
This session carries one durable goal and keeps working toward it across turns. Do not stop to announce progress while concrete work remains; take the next action instead. Systematic passes sweep these bug classes: sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race. Every 3 systematic passes, run a deep-reading pass that models dataflow, trust boundaries, and state machines to form and test hypotheses beyond pattern matching. Declare completion only with update_goal action complete once the objective is genuinely achieved; ending a turn does not end the mission.
```

#### Token effect

Small fixed input cost on every request where the section registration is in scope.

#### KV Cache effect

Prefix-stable while the plugin scope and configuration are unchanged. Activation, disposal, or configuration changes may invalidate reuse from this prompt section.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Startup-only arming** — a resumed or cleared session keeps the goal service's restored (disarmed) goal; automatic re-arming on resume and on quota standby wake belongs to the hard-standby plugin.
- **Completion path assumes the goal tools** — the contract names `update_goal action complete`; a composition without `dsh-tool-goal` must surface that action through another consumer.
- **No completion evaluator** — arming and guidance only; certification of completion is deferred to the hard stop gate and verifier packages. The matrix is the denominator the future completion gate will consume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
