---
kind: upgrade-guide
description: "The hard and hard-web profile templates disappear; the hard harness becomes an optional bundle switched on per profile through the plugin manager."
---

# Hard profiles replaced by the optional hard bundle

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, `dsh --profile hard` and `dsh --profile hard-web` auto-initialized shipped templates that selected `@deepseek-ai/dsh-experimental-hard-bundle` over the headless or Web composition. Anyone running the pilot used those two profile names.

The next release removes both templates: `dsh --profile hard` reports `profile "hard" does not exist`, and no profile name arms the hard harness automatically. The hard bundle ships as an installation-owned optional bundle instead — the same shelf the agent-team, voice-input, auto-review, and inspector bundles use. It is listed switched off in the plugin manager, and switching it on appends it to the selected profile's bundle list; the coverage panel rides the same bundle and mounts whenever the profile's composition carries the Web app.

Profiles that already exist on disk keep their bundle list untouched: an existing `hard` profile that names the bundle still boots it.

## Migration

1. Open the plugin manager (Web client, right sidebar, Plugins) or run `dsh plugin --profile <name>` and switch `@deepseek-ai/dsh-experimental-hard-bundle` on for the profile that should carry it. A Web composition gives the sessions the coverage panel; a headless one does not.
2. Confirm: the profile's `$DSH_HOME/profiles/<name>/package.json` lists the bundle in `dsh.profile.bundles`, and `dsh --profile <name>` starts with no `cannot resolve profile bundle` line.
3. Patch layers that targeted the `hard-web` profile by name keep working as files; re-point any automation that launched `--profile hard-web` at the profile that now carries the bundle.
