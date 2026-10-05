---
description: "Optional hard-agent bundle: mission arming, the turn stop gate, quota standby, and compaction handoff, for sessions that must keep one objective alive."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-hard-bundle

English | [中文](README.zh.md)

## Summary

Enable this optional bundle to mount all nine hard plugins as one layer: `hard-mission` arms the configured objective as a durable session goal, `hard-stopgate` steers the turn boundary back to work while that goal stands, `hard-standby` waits out terminal quota failures and wakes the mission at the reset time, and `hard-handoff` injects the durable ledger summary after each successful compaction. The bundle ships with a blank objective and fails the load until the deployment supplies one through its own patch.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Insert the bundle's patch layer after `dsh-base` and override the mission objective from your composition, for example through `cordis.patch.yml`:

```yaml
- overwrite:
    id: hard-mission
    config:
      objective: 'Find and verify every authentication bypass in the target repository'
```

The goal tools and the goal service come from `dsh-base`; this bundle adds only the mission, the stop gate, the standby, and the handoff.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `hard-mission` row with a blank objective — a deliberate loud failure until the deployment sets a real one — and the stop-gate, standby, handoff, rounds, and deep-read rows with default config. Each plugin owns its behavior and lifetime; see [hard-mission](../hard-mission/README.md), [hard-stopgate](../hard-stopgate/README.md), [hard-standby](../hard-standby/README.md), [hard-handoff](../hard-handoff/README.md), [hard-rounds](../hard-rounds/README.md), and [hard-deepread](../hard-deepread/README.md).

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this bundle only mounts the nine hard plugins; their prompt sections, steering messages, wake follow-ups, and injected handoffs are owned and documented by those packages.

#### KV Cache effect

None; the bundle adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Blank objective fails the load by design** — the shipped row carries `objective: ''`; a deployment that enables the bundle must supply the objective through its own patch.
- **Headless-first** — the bundle composes plugins for CLI and headless profiles; Web/desktop presentation for hard sessions is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
