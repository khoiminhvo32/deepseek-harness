---
description: "The hard-standby plugin for hard-harness deployments waiting out terminal quota and transient provider failures and waking the mission afterwards."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-standby

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-standby` keeps a hard-harness session alive through provider quota exhaustion and transient provider failures. When a root agent with an active goal hits a terminal `QUOTA` failure, the plugin schedules a wake at the provider's reset delay, a configured reset cron, or the standby cap; on `RATE_LIMIT`, `SERVER`, `TIMEOUT`, or `TRANSPORT` it wakes after the provider's delay or `transientRetryMinutes`. It records the wait as `hard/standby/scheduled` and lets the failed turn end. At the wake it re-arms an active disarmed goal, records `hard/standby/woke`, and delivers a continuation follow-up.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service and the hard mission in hard-harness compositions; the stop gate reads its `hardStandby` projection to let turns close cleanly while a wait is pending.

```yaml
- id: hard-standby
  name: '@deepseek-ai/dsh-experimental-hard-standby'
  config:
    quotaResetCron: '0 9 * * *'
    maxStandbyHours: 24
    transientRetryMinutes: 5
```

`enabled: false` mounts nothing: the session then ends on quota failures like any unmanaged one. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-standby) is the exhaustive source for every accepted field.

Wake times resolve in a fixed order: the provider's `Retry-After` delay wins when the adapter reports one; otherwise the next match of `quotaResetCron` (five-field Vixie form, evaluated in UTC at minute granularity) names the window; otherwise the wait runs to `maxStandbyHours`. Every wait is capped at `maxStandbyHours`, and the cap doubles as the retry cadence when neither source names a reset time, so an unmanaged quota outage retries on a bounded rhythm rather than stalling silently. A transient failure never waits for the cron or the cap: it wakes after the provider's delay, or after `transientRetryMinutes` (default 5) when the provider names none, still bounded by `maxStandbyHours`. The goal driver disarms the goal on any turn error, so without this wake a rate-limited turn would leave the mission idle until a human resumed it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Waterfall observer, never a retry.** The `agent/request-error` listener only schedules: it records the standby event, arms the wake timer, and always calls `next()`, leaving the failure terminal. Transient noise stays the retry policy's business.
- **Durable state machine.** The `hardStandby` session projection folds `hard/standby/scheduled` into a pending wait and `hard/standby/woke` back to idle; the framework restores it at resume, so a session that restarts mid-wait re-arms its remaining wait when the agent is recreated from a `resume` source. A root agent's model reply during a pending wait proves the quota window ended early (a recharge, or a user who resumed by hand), so the plugin cancels the timer and closes the wait with an undelivered `hard/standby/woke`; otherwise the stop gate would keep treating the session as standing by until the stale wake time.
- **Delegated agents stopped on a quota or outage are reported, not revived.** Only the root carries the goal the standby resumes, so a delegated agent whose turn ends on a quota or transient failure stays unfinished. The plugin remembers its id under its root agent and, on the root's first model reply afterwards, injects one `hard-standby` notice naming those agents and telling the model to continue each with `send_message` (the agent keeps its transcript) or reassign its work. The list lives in the Host process: a restart before that reply drops it.
- **Delivery respects goal authority.** At wake, a live active goal is followed up directly when armed; an active disarmed goal is resumed first through the goal service. Paused, blocked, and completed goals are never revived — only the active phase continues, and a goal at its round cap is left disarmed with the skip recorded.
- **Bounded timers.** Waits longer than one `setTimeout` bound chain through it; agent disposal cancels the timer, and plugin unload cancels every pending wake.

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | `SessionEventMap` merge for the two `hard/standby/*` events |
| [`src/cron.ts`](src/cron.ts) | Five-field UTC cron parsing and next-match arithmetic |
| [`src/wake.ts`](src/wake.ts) | Pure wake-time resolution: provider delay, cron window, cap |
| [`src/projection.ts`](src/projection.ts) | Session-projection unit: pure fold, state schema, definition |
| [`src/index.ts`](src/index.ts) | Plugin: quota and outage listener, wake timers, delivery decision |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Follow-up messages

#### What the model sees

One continuation order per wake, delivered as a `hard-standby`-sourced user message after the wait: the provider code that caused the wait, the instruction to read durable ledger state, and the requirement to continue concrete mission work rather than wait or ask for permission. Scheduled and woke records themselves are durable log events without request content.

#### Token effect

One bounded message per wake cycle; no standing prompt cost.

#### KV Cache effect

The message appends after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **In-process waits** — the wake timer lives in the Host process; a process that exits mid-wait relies on the durable `scheduled` record and a later `resume` to re-arm. A long-running composition that stops entirely between quota windows does not self-start.
- **Fixed failure families** — `QUOTA` and `ACCOUNT_QUOTA` schedule a quota wait, and `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT` an outage wait; every other code, such as `AUTH` or `CONTEXT_WINDOW_EXCEEDED`, ends the session as before, because waiting cannot cure it.
- **UTC cron only** — `quotaResetCron` has no time-zone support; regions with zone-dependent reset windows need the offset baked into the expression.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The stop gate reads the `hardStandby` projection state directly by key rather than injecting a standby service, so the two plugins compose without a runtime dependency; the projection key and state type are the shared contract.

</details>
