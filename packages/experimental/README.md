---
description: "The experimental group map: publicly installable pre-stable prototypes."
kind: "package-group"
---

# packages/experimental

English | [中文](README.zh.md)

## Summary

Experimental prototypes may change their contracts and carry no support promise. New packages publish by default; private packages must also appear in the [private-exception list](../../scripts/experimental-package-policy.ts). All current packages publish under their `@deepseek-ai/dsh-experimental-*` names, including the opt-in Agent Teams composition, Auto review, Cua Driver providers, browser-use backends, cross-realm Inspector, CPython PTC backend, and browser-worker preview libraries. Released products outside this group must not depend on experimental packages. The dsh installation ships the Agent Teams, voice input, and Auto review packages as optional bundles switched on from the Web sidebar's Plugins page ([decision](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)); the other packages are libraries or explicit compositions.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`speech-to-text`](speech-to-text/README.md) | Named speech recognition providers | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.md) | Managed local SenseVoice inference | — |
| [`api-speech-to-text`](api-speech-to-text/README.md) | Authenticated transient transcription Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.md) | Microphone capture and guarded draft insertion | — |
| [`voice-input-bundle`](voice-input-bundle/README.md) | Default-disabled optional voice input composition | — |
| [`agent-team-profile`](agent-team-profile/README.md) | Agent Teams collaboration, tools, and Web UI bundle | — |
| [`agent-team`](agent-team/README.md) | Named teammates with durable messages and a shared task board | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.md) | Team roster, task board, and teammate navigation for Web | — |
| [`auto-review`](auto-review/README.md) | Explicit Web layer for same-model review before each native or PTC inner tool call | — |
| [`claude-code-mods`](claude-code-mods/README.md) | Run Claude Code mods as plugins: their hook chains on harness extension points and a band above the prompt | `ctx.claudeCodeMods` |
| [`client-ui-claude-code-mods`](client-ui-claude-code-mods/README.md) | The Web band that draws a mod's tree above the prompt and sends button clicks back | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.md) | CPython subprocess backend for the PTC execution seam | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.md) | Use an installed Cua Driver through MCP | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.md) | Embed the Cua Driver native npm runtime | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.md) | Playwright browser tools over MCP | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and browser control over MCP | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.md) | Stagehand browser operations with explicitly configured native models | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.md) | Session-owned browser resources shared by experimental providers | — |
| [`inspector`](inspector/README.md) | Cross-realm CDP hub for Host debugging, Client Runtime inspection, network capture, and Cordis trees | `ctx.inspector` |
| [`session-inspector`](session-inspector/README.md) | Sidebar tables for raw Session logs and Chat nodes | — |
| [`inspector-profile`](inspector-profile/README.md) | Optional Web bundle for Session log and Chat node inspection | — |
| [`tool-agent-team`](tool-agent-team/README.md) | Nine tools that let the model create, message, and coordinate teammates | registers scoped tools on `ctx.tools` |
| [`hard-mission`](hard-mission/README.md) | Arms the configured objective as a durable goal and teaches the mission contract | — |
| [`hard-stopgate`](hard-stopgate/README.md) | Steers the turn boundary back to work while an armed goal is active | — |
| [`hard-standby`](hard-standby/README.md) | Waits out terminal quota failures on a bounded schedule and wakes the mission | — |
| [`hard-handoff`](hard-handoff/README.md) | Injects the durable ledger summary after each successful compaction | — |
| [`hard-rounds`](hard-rounds/README.md) | Round accounting, A/B rotation, and the per-round step budget over the goal-round driver | — |
| [`hard-deepread`](hard-deepread/README.md) | The Phase B deep-reading contract: flow documents and subagent fan-out | — |
| [`hard-audit`](hard-audit/README.md) | Opt-in shadow audit: a fresh, blind reader re-reads a sample of cleared cells | — |
| [`hard-cpg`](hard-cpg/README.md) | Opt-in Joern call-graph facts for the pinned commit, built with a fixed packaged query | `ctx.hardCpg` |
| [`hard-ledger`](hard-ledger/README.md) | Durable findings, hypotheses, coverage, and sweep state over `hard/*` session events | `ctx.hardLedger` |
| [`hard-verifier`](hard-verifier/README.md) | Executes findings' proofs of effect and recomputes their CVSS 4.0 scores | `ctx.hardVerifier` |
| [`hard-tools`](hard-tools/README.md) | Model-facing finding, hypothesis, coverage, and sweep tools | registers tools on `ctx.tools` |
| [`hard-bundle`](hard-bundle/README.md) | Optional hard-agent composition of the six hard plugins | — |
| [`webworker-packer`](webworker-packer/README.md) | Builds the gzip-compressed VFS image consumed by the browser worker preview | library and CLI — no ctx key |
| [`webworker-runtime`](webworker-runtime/README.md) | Runs the harness plugin tree inside a dedicated browser worker | library and worker entry — no ctx key |

-----

<a id="related-documentation"></a>
## Related documentation

- [Experimental publication reference](../../scripts/experimental-package-policy.ts) — public defaults and private exceptions.
- [Computer use](../../docs/subsystems/computer-use.md) — desktop provider choices.
- [Browser use](../../docs/subsystems/browser-use.md) — browser provider choices and Session ownership.
- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [Experimental subtree rules](AGENTS.md) — what experimental status does and does not relax.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
