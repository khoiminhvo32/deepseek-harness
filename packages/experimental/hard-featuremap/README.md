---
description: "The hard-featuremap plugin for hard-harness deployments importing Joern facts into a shared SQLite feature map."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-featuremap

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-featuremap` provides the `hardFeatureMap` service, which imports the Joern facts `hard-cpg` builds for a mission's pinned commit into one SQLite database shared across projects: symbols, call edges tagged with the rule that made each, and the entry points and routing guards of the configured framework profiles. It gives the model `hard_query_map`, `hard_record_feature`, and `hard_link_feature`, and records a feature only after checking that it accounts for every symbol its entry points require, guards and state writes included. The plugin ships switched off.

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
    frameworks: [wordpress]
```

The bundle sets `dbPath` to `featuremap.db` under the harness home's `hard` directory. `frameworks` lists the profiles to read, any of `wordpress`, `laravel`, `spring`, `aspnet`, `flask`, `fastapi`, and `express`; empty keeps call edges only. Set `hard-cpg`'s `language` to match. `scriptDirs` lists the directories whose top-level PHP files are requested directly; empty selects the WordPress install's root, `wp-admin`, `wp-admin/network`, and `wp-admin/user` when the WordPress profile is on. With `indexOnArm` (default on), arming a mission imports in the background and logs the edge counts. Indexing also records the entry points in the session, and the ledger's `minEntryMappedPercent` (default 80) holds the completion gate until recorded features cover that share. The check reads `featureDepth` (default 4) call levels from a feature's handlers, does not expand symbols with more than `libraryFanIn` (default 40) distinct callers, requires the non-library symbols within `requiredDepth` (default 2) plus every reached name in `guards` and `mutations` (empty selects the WordPress lists when that profile is on), and lets a feature exclude at most `maxExcludedPercent` (default 50) of its required symbols. Consumers call `ctx.hardFeatureMap.index(agent)` for a snapshot id, then `callers`, `callees`, and `entryPoints`; `featureGraph(agent, featureId)` and `symbolDetail(agent, symbol)` return the display data of the [feature map tab](../client-ui-hard/README.md#read-the-feature-map). Where a Web connection exists, the enabled plugin serves those two as `GET /api/hard-featuremap.feature?session=<id>&feature=<FE-n>` and `GET /api/hard-featuremap.symbol?session=<id>&symbol=<id>`; they answer 400 without both parameters, 404 for a session without a live agent or an unknown feature or symbol, and 409 with the error when the read fails. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-featuremap) lists every field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Every edge names its source.** `joern` is the graph's own resolution. `repair` covers a type-qualified, `parent`/`self`/`static`, or receiverless call (Ruby) resolved through the type lineage, and a class-qualified call PHP routes to the global function (Joern issue 3050). `unique-name` links a dynamic call on an unknown receiver only when one method carries the name. `hook` links a firing with a literal name to each callback registered under it. A consumer weighs a `unique-name` edge below the others.
- **Facts name the target or nothing is linked.** A repair adds an edge only when the facts name exactly one target; a computed hook name, a closure callback, or a variable call stays unlinked.
- **WordPress entry points.** Admin-ajax and admin-post actions come from hook registrations, with `nopriv` actions public; admin-ajax handlers also come from the core naming convention `wp_ajax_<action>`, because core registers most actions in a loop with computed names. REST handlers are the `get_items`, `get_item`, `create_item`, `update_item`, and `delete_item` methods of `WP_REST_Controller` descendants. Shortcodes and directly requested scripts complete the list.
- **HTTP route profiles.** Each route is an entry point of kind `http` keyed `VERB path` with its routing guards. Spring joins the class `@RequestMapping` prefix and reads `@PreAuthorize`, `@Secured`, and `@RolesAllowed`; ASP.NET Core expands `[controller]` and `[action]` in `[Route]` and reads `[Authorize]`, with `[AllowAnonymous]` making a route public; Flask and FastAPI read route decorators with a path and treat access-named decorators such as `login_required` as guards; Express reads `get`, `post`, and similar routing calls, takes the last argument as the handler (a referenced closure or a same-file function) and the others as middleware; Laravel reads `Route::` calls with controller arrays, `Controller@method` strings, or closures, and chained `middleware`. A route with guards is `authenticated`, an explicitly open one `public`, and the rest `unknown`, because global middleware is not read.
- **One snapshot per derivation.** A snapshot is keyed by target root, commit, and a digest of the facts cache key, the frameworks, the script directories, and the import version. A different derivation imports beside the old one; the same one is reused, and concurrent requests share one import.
- **A feature must account for what it reaches.** From the handlers of a feature's entry points the check walks call edges to `featureDepth`, stops expanding at widely shared library symbols, and computes the required set: the handlers, the near non-library symbols, and every reached guard and state write. A claim must make each required symbol a member or an exclusion with a reason (`utility`, `other-feature`, `unreachable`); a guard or state write cannot be excluded as `utility`; a member outside the reach needs `via`, the reached caller and the line, which the harness reads at the pinned commit and requires to mention the symbol; and a member with role `guard` or `mutation` must be or call one. Every shortfall is reported at once, and only a passing claim reaches the ledger.
- **Display reads stay bounded.** The feature graph holds a recorded feature's members and exclusions and the call edges among them. The symbol detail returns at most 100 callers and 100 callees and at most 200 source lines, read from the harness snapshot at the pinned commit; a symbol without a location or snapshot has no source.
- **Derived, so rebuilt.** A database stamped with another schema version is dropped and recreated, because the facts can always be imported again.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the `hardFeatureMap` service, and the arming trigger |
| [`src/model.ts`](src/model.ts) | In-memory fact index and type lineage |
| [`src/repair.ts`](src/repair.ts) | Call edges and repairs |
| [`src/wordpress.ts`](src/wordpress.ts) | WordPress hooks, hook edges, and entry points |
| [`src/http.ts`](src/http.ts) | HTTP route profiles |
| [`src/store.ts`](src/store.ts) | SQLite schema, import, and queries |
| [`src/check.ts`](src/check.ts) | Reach, required set, and the feature completeness check |
| [`src/tools.ts`](src/tools.ts) | The three model tools and the prompt section |
| [`src/web.ts`](src/web.ts) | The feature map tab's Host routes |
| [`src/routes.ts`](src/routes.ts) | The route paths, free of imports for Client tests |
| [`src/types.ts`](src/types.ts), [`src/client.ts`](src/client.ts) | Display types and their types-only `./client` export |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

When the plugin is enabled, the `hard:feature-map` section teaches the mapping task: list entry points, find symbol ids, read what a feature must account for, record each feature with its symbols, exclusions, and state, and link features that write the same state behind different guards.

##### Feature map section

```markdown
Feature map. The harness builds a map of the target from its call graph: entry points a request reaches, the symbols behind them, and the guards and state writes they reach. Map every feature: list entry points with hard_query_map (view entry-points, unmapped_only true), find symbol ids with view symbol, and see what a feature must account for with view required and its entry points. Record each feature with hard_record_feature: a name, what it does and for whom, its entry points, its symbols with roles (entry, guard, mutation, helper), the required symbols it leaves out with a reason (utility, other-feature, unreachable), and the state it reads or writes. The harness refuses a feature that leaves a required symbol unaccounted for, excludes a guard or a state write as utility, or names a symbol outside the reach without citing the call that reaches it (via). Link related features with hard_link_feature. Two features that write the same state behind different guards are where feature abuse hides: link them with kind shares-state and test the weaker path.
```

#### Token effect

Small fixed input cost on every request while the plugin is enabled.

#### KV Cache effect

Prefix-stable while the plugin is enabled; enabling or disabling it changes the prompt prefix.

### Tool schemas and results

#### What the model sees

The generated [`hard_query_map`, `hard_record_feature`, and `hard_link_feature` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-hard-featuremap). Results are compact JSON: a page of entry points with their routing guards and whether a feature covers them, matching symbols, a page of call edges with the rule that made each, the required set of given entry points with each symbol's reasons, the recorded feature id with the reach and required-set sizes and the count of entry points still unmapped, or the recorded link. A refused feature returns every shortfall at once.

#### Token effect

Fixed schema cost while the plugin is enabled, plus one compact result per call; pages hold at most 200 items and a refusal lists at most 20 missing symbols by name.

#### KV Cache effect

Schemas are prefix-stable while the plugin is enabled. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **REST routes registered outside controllers** — `register_rest_route` callbacks in nested arrays are not read; plugin routes outside `WP_REST_Controller` descendants are missing.
- **Cron and XML-RPC entry points** — scheduled hooks and the XML-RPC method table are not entry points yet; `xmlrpc.php` appears as a script.
- **Route prefixes outside the declaration** — Express routers mounted with `app.use('/prefix', router)`, Laravel route groups and `Route::resource`, and ASP.NET conventional routes are not read; Django has no profile.
- **Check cost** — the check queries the database per reached symbol; on WordPress the Quick Edit feature (185 reached symbols) takes about 4 seconds.
- **Guard and state-write lists** — only the WordPress profile supplies default lists; other frameworks rely on the near-symbol rule unless `guards` and `mutations` are configured.
- **Global middleware** — app-wide authentication is invisible to the profiles, so a route without its own guard is `unknown`, not `public`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Measured on WordPress 7.1.3 facts with PoC stubs excluded: 183,100 call sites gave 53,338 `joern`, 20,780 `repair`, 3,927 `unique-name`, and 1,692 `hook` edges; every call site of `wp_insert_post` (24, matching grep), `wp_delete_post`, `update_user_meta`, `wp_set_current_user`, and `check_ajax_referer` is linked; 1,348 of 1,435 hook registrations resolve their callback; 370 entry points (114 admin-ajax actions, 99 REST handlers, 8 shortcodes, 149 scripts). Deriving took about 0.6 seconds and the import about 1 second, for a 52 MB snapshot.

</details>
