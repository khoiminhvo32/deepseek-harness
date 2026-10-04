---
description: "The hard-mission plugin for deployments running one long-lived objective that the session must keep working toward."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-mission` arms the configured objective as a durable session goal and registers the `hard:mission` system-prompt section that teaches the mission contract: keep working across turns, alternate systematic and deep-reading passes, and declare completion only through the goal tools. It arms fresh root agents on `startup` only; resumed, cleared, compacted, and child agents keep their own goal state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service when a deployment owns one long-lived objective, such as continuous vulnerability research over a pinned target repository. The objective must be configured; a blank objective fails the load.

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
```

`bugClasses` defaults to the systematic-pass list of every OWASP Top 10 class with mechanical source-to-sink semantics (sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race); an empty list removes the class list from the contract. Insecure design and security logging have no mechanical source-sink pair and stay in the deep-reading pass. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-mission) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Arming at creation.** The plugin listens on `agent/created` and arms a goal through `ctx.goals.create` only when the source is `startup`, the agent is a registry root, and no goal is current. Every other source, child agent, or existing goal is left untouched, so the goal service's restore-and-disarm policy for persisted sessions stays authoritative.
- **One contract section.** The `hard:mission` section renders the objective, the systematic-pass class list, and the deep-reading cadence from the resolved config. It is static text: it changes only when the deployment configuration changes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, contract rendering, section registration, startup arming |

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
- **No completion evaluator** — arming and guidance only; certification of completion is deferred to the hard stop gate and verifier packages.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
