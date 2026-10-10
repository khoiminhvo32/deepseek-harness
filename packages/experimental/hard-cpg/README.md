---
description: "The hard-cpg plugin for hard-harness deployments building Joern call-graph facts for the pinned snapshot commit."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-cpg

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-cpg` provides the `hardCpg` service, which turns the hard mission's pinned snapshot commit into Joern facts: target files, internal methods, and call sites with their resolved internal targets and bounded argument summaries. It exports the commit with `git archive`, runs Joern's PHP frontend and one packaged query through the shell seam, and caches the validated JSON Lines file beside the snapshot store per commit and query digest. The plugin ships switched off; a deployment enables it after installing Joern.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install a Joern distribution (JDK 21 and PHP on the path), then enable the row the hard bundle already mounts:

```yaml
- id: hard-cpg
  config:
    enabled: true
    joernHome: '/opt/joern/joern-cli'
    excludePaths: ['poc']
```

`excludePaths` lists repository-relative paths the frontend skips; leave it empty to cover the whole pinned commit, and list PoC stubs that redefine target functions, because they capture calls in the graph. With `buildOnArm` (default on), arming a mission starts a background build and logs the counts. Consumers call `ctx.hardCpg.facts(agent)` and read the file with `readHardCpgFacts`. Each step runs under the shell's per-command timeout cap as well as `stepTimeoutMinutes`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-cpg) lists every field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Pinned content only.** The export reads the snapshot store at the pinned commit, never the live target, so facts and citations describe the same files.
- **Packaged query only.** Joern's interpreter runs arbitrary Scala, so the service passes it nothing but the packaged script and harness-built paths; the [decision note](../../../.agents/notes/implemented/architecture/2026-10-10-hard-harness-maps-features-from-joern-facts.md) records why.
- **Framework-neutral facts.** The query writes fact format 1: a header row, file, method, and call rows, and an end row. A call row carries Joern's target name, the internal methods it resolves to, the dispatch kind, and up to four argument summaries; a desugared array literal argument becomes its element texts, which is how a callback array keeps the method it names.
- **Validated before use.** A build counts the whole file through the reader before moving it into the cache, and the reader refuses a missing header, an invalid row, or a missing end row, so a cut-short export never serves.
- **One build per key.** The cache key digests the fact format, the query text, `joernHome`, and `excludePaths`; concurrent requests for one key share a build, and disposing the plugin cancels running steps.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the `hardCpg` service, the build steps, and the arming trigger |
| [`src/facts.ts`](src/facts.ts) | Fact format schema, reader, and counter |
| [`src/query.ts`](src/query.ts) | The packaged Joern query |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only writes fact files beside the snapshot store; consumers own any model-facing use.

#### KV Cache effect

None; the plugin adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **PHP only** — the build runs the PHP frontend; other languages need their frontend and their own measurements.
- **Joern's PHP call resolution is incomplete** — free functions called inside classes resolve to nonexistent class methods, and `parent::`, late static binding, variable calls, and computed names stay unresolved; repairs belong to the consumer over these facts.
- **Snapshot records only** — an arming record without a harness snapshot has no store to export from and is refused.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Measured on WordPress 7.1.3 with Joern v4.0.653: the frontend took about 30 seconds and the query about 30 seconds, and the fact file was about 48 MB for 1,513 files, 14,500 methods, and 183,000 call sites.

</details>
