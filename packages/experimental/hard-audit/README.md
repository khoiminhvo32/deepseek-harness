---
description: "The hard-audit plugin for hard-harness deployments having a fresh, blind reader re-read a sample of cleared coverage cells in shadow mode."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-audit

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-audit` measures how often the mission agent clears a coverage cell wrongly. It samples model clears by tier, records `hard/audit/requested`, and spawns a fresh reader that sees the cell, the pinned target, and a neutral bug-class definition, never the mission agent's claims. The reader's flag or corroboration, checked at the pinned commit, lands in `hard/audit/result`. Shadow mode: the mission agent's open work, completion gate, and messages never change.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The hard bundle mounts the plugin switched off, because every audit spends model tokens on a cold context. A deployment opts in by patching the row:

```yaml
- id: hard-audit
  config:
    enabled: true
    auditModel:
      provider: other-provider
      model: other-model
    maxAuditsPerMission: 12
```

A clear is sampled by its tier: `unscreenedAuditPercent` for model reads in modules the grep cross-check cannot screen, `batchAuditPercent` for batch screens nobody read, and `auditPercent` for screenable per-cell reads. Harness clears are never audited. The sample hashes the cell with the pinned commit, so it differs between targets and stays stable across resumes. A sampled clear past `maxAuditsPerMission` is recorded as `unavailable` for `budget`. A reader from a different model family through `auditModel` is the strongest independence; omitted, the reader uses the mission agent's route. `readerTools` is an allow-list, so tools added later stay hidden from the reader, and it refuses ledger, session, and goal tools. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-audit) lists every field.

Each reader works in its own temporary worktree of the pinned snapshot, so the mission agent's later edits and PoCs never reach it, whatever the target is. An arming record without a snapshot, from builds that predate snapshots, makes every audit `unavailable` with cause `git`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Blind to claims, not to code.** The reader's prompt carries the target path, the commit, the cell, and a neutral class definition, and grants the whole repository: authorization and injection flows cross modules. The verdict, declared sites, notes, flow documents, hypotheses, findings, and other audits never reach it. The `auditProvider` must start a child that does not inherit the parent conversation, checked when each mission agent is created.
- **A pristine worktree, checked after the fact.** Before each read the plugin checks the pinned commit out of the harness-owned snapshot into a fresh temporary worktree beside the store, under a sandbox that confines the write to the snapshot root, runs the reader with that worktree as its working directory, and removes it afterwards. Read tools can still open any path, so blindness is verified from the reader's own log: every path argument of `read`, `read_image`, `glob`, `grep`, and `lsp` must resolve, through symlinks, inside the worktree. A path the reader's own earlier tool result named — its spill file — is allowed. Any other read, including the live target with the mission agent's PoCs, records `contaminated` and voids the measurement.
- **Binary cells.** A module holding a non-inert binary at the pinned commit is `binary` without a reader, because the reader has no decompiler.
- **Resolved reports only.** Every location or examined symbol must resolve at the pinned commit through the verifier's citation check, and at least one must lie in the audited cell; otherwise the result is `citation`.
- **Held at idle.** When the mission agent goes idle with audits still queued or running, the plugin claims the agent's maintenance slot in the idle transition until they settle, so a one-shot headless run, which exits when the agent idles, records them first. Input that wakes the agent during the hold waits; nothing the mission agent sees changes. `drainWhenIdle: false` turns the hold off.
- **Quota stops wait instead of measuring.** A reader whose turn ends on provider quota (`QUOTA` or `ACCOUNT_QUOTA`) read nothing, so its request records no result and charges nothing against `maxAuditsPerMission`. It parks for `quotaRetryMinutes` (default 5) and runs again on the first mission-agent reply after that wait, which shows the provider answers again, or when the session resumes.
- **Durable and resumable.** The `hardAudit` projection folds the latest verdict seq per cell, pending requests, and the charged budget. A resumed mission restarts pending audits; a request whose cell was marked again before its reader started settles as `superseded`. Neither a `superseded` nor a `budget` result charges the budget, so a model that marks the same cell again spends one audit, not one per mark.

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | `SessionEventMap` merge for `hard/audit/requested` and `hard/audit/result` |
| [`src/projection.ts`](src/projection.ts) | Session-projection unit: verdict seqs, pending requests, charged budget |
| [`src/prompt.ts`](src/prompt.ts) | Reader persona, task prompt, class definitions, and report schema |
| [`src/reads.ts`](src/reads.ts) | Read-path extraction and the contamination check |
| [`src/index.ts`](src/index.ts) | Plugin: sampling, queue, workspace checks, reader run, result |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Reader session

#### What the model sees

The mission agent sees nothing: no message, tool, or prompt changes. Each reader is a separate child session whose system prompt carries a persona that shadows the deployment persona, telling it to read adversarially and that mission or ledger instructions elsewhere address another agent. Its user message names the target, the commit, the cell, and the class definition, and asks for one vulnerability with locations or, when none is found, the examined symbols. It holds only the reader tools and the `structured_output` tool.

#### Token effect

One cold-context child run per sampled clear, bounded by `maxAuditsPerMission`; the reader does not reuse the mission agent's prompt cache. The mission agent's requests are unchanged.

#### KV Cache effect

None for the mission agent; each reader builds its own prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Shadow mode only** — a flag does not reopen the cell or block completion yet; binding audits to the gate waits for measured cost and flag rates.
- **Detection, not confinement** — the read tools stay unconfined, so a contaminated read is voided after it happened, not prevented.
- **Held idle** — an idle mission agent waits for its audits, so audits can lengthen a mission's wall-clock time and an interactive user's next message waits behind them.
- **Binary modules** — the reader has no decompiler, so any module or repository-wide cell holding a non-inert binary is `binary`.
- **Global mission sections** — the mission and deep-read system-prompt sections still reach the reader; they carry the objective, not claims.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The reader's tool calls, results, and usage are observed through `session/event` keyed by the child session the run label identifies, never by reading the child log back. The recorded-session snapshot corpus has no scenario for this plugin: the reader runs concurrently with the mission agent, so the interleaving of audit records in the mission log is not deterministic; the real-composition end-to-end test covers it instead.

</details>
