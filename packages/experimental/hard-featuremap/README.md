---
description: "The hard-featuremap plugin for hard-harness deployments importing Joern facts into a shared SQLite feature map."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-featuremap

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-featuremap` provides the `hardFeatureMap` service, which imports the Joern facts `hard-cpg` builds for a mission's pinned commit into one SQLite database shared by every project and session. It stores symbols, call sites, and call edges tagged with the rule that made each edge, and, under the WordPress profile, hook registrations, firings, and entry points. Repairs fill the call edges Joern's PHP frontend leaves unresolved. The database holds only derived data, so it is rebuilt rather than migrated. The plugin ships switched off.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the row the hard bundle already mounts, together with `hard-cpg`:

```yaml
- id: hard-featuremap
  config:
    enabled: true
    framework: wordpress
```

The bundle sets `dbPath` to `featuremap.db` under the harness home's `hard` directory. `framework: wordpress` adds hooks and entry points; `none` keeps call edges only. `scriptDirs` lists the directories whose top-level PHP files are requested directly; empty selects the WordPress install's root, `wp-admin`, `wp-admin/network`, and `wp-admin/user`. With `indexOnArm` (default on), arming a mission imports in the background and logs the edge counts. Consumers call `ctx.hardFeatureMap.index(agent)` for a snapshot id, then `callers`, `callees`, and `entryPoints`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-featuremap) lists every field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Every edge names its source.** `joern` is the graph's own resolution. `repair` covers a type-qualified or `parent`/`self`/`static` call resolved through the type lineage, and a class-qualified call PHP routes to the global function (Joern issue 3050). `unique-name` links a dynamic call on an unknown receiver only when one method carries the name. `hook` links a firing with a literal name to each callback registered under it. A consumer weighs a `unique-name` edge below the others.
- **Facts name the target or nothing is linked.** A repair adds an edge only when the facts name exactly one target; a computed hook name, a closure callback, or a variable call stays unlinked.
- **WordPress entry points.** Admin-ajax and admin-post actions come from hook registrations, with `nopriv` actions public; admin-ajax handlers also come from the core naming convention `wp_ajax_<action>`, because core registers most actions in a loop with computed names. REST handlers are the `get_items`, `get_item`, `create_item`, `update_item`, and `delete_item` methods of `WP_REST_Controller` descendants. Shortcodes and directly requested scripts complete the list.
- **One snapshot per derivation.** A snapshot is keyed by target root, commit, and a digest of the facts cache key, the framework, the script directories, and the import version. A different derivation imports beside the old one; the same one is reused, and concurrent requests share one import.
- **Derived, so rebuilt.** A database stamped with another schema version is dropped and recreated, because the facts can always be imported again.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the `hardFeatureMap` service, and the arming trigger |
| [`src/model.ts`](src/model.ts) | In-memory fact index and type lineage |
| [`src/repair.ts`](src/repair.ts) | Call edges and repairs |
| [`src/wordpress.ts`](src/wordpress.ts) | Hooks, hook edges, and entry points |
| [`src/store.ts`](src/store.ts) | SQLite schema, import, and queries |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only writes and queries a database beside the snapshot store; later tools own any model-facing use.

#### KV Cache effect

None; the plugin adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **REST routes registered outside controllers** — `register_rest_route` callbacks in nested arrays are not read; plugin routes outside `WP_REST_Controller` descendants are missing.
- **Cron and XML-RPC entry points** — scheduled hooks and the XML-RPC method table are not entry points yet; `xmlrpc.php` appears as a script.
- **WordPress only** — other frameworks need their own profile; `none` keeps call edges for any language Joern exports.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Measured on WordPress 7.1.3 facts with PoC stubs excluded: 183,100 call sites gave 53,338 `joern`, 20,780 `repair`, 3,927 `unique-name`, and 1,692 `hook` edges; every call site of `wp_insert_post` (24, matching grep), `wp_delete_post`, `update_user_meta`, `wp_set_current_user`, and `check_ajax_referer` is linked; 1,336 of 1,435 hook registrations resolve their callback; 370 entry points (114 admin-ajax actions, 99 REST handlers, 8 shortcodes, 149 scripts). Deriving took about 0.6 seconds and the import about 1 second, for a 52 MB snapshot.

</details>
