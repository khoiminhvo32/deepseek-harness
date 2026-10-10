# Agent Note: The hard harness maps features from Joern facts

Status: implemented

English | [中文](2026-10-10-hard-harness-maps-features-from-joern-facts.zh.md)

## Problem

The hard harness finds bugs through source-to-sink sweeps per module and bug class. Three of the four findings of the WordPress 7.1.3 mission were a different kind: two features touch the same state under different authorization checks (the widgets REST edit context, re-parenting an attachment without `edit_post`, `find_posts` returning draft titles). Hunting that kind needs a map of the target's features: which functions implement each feature, where each is called from, which state each reads and writes, and which checks guard it. A model can write such a map while it reads, but reading every function of a mid-size target to list callers costs most of a mission's token budget, and a map the model writes alone is a claim the harness cannot check.

Joern builds a code property graph (syntax tree, control flow, call graph, data flow) from source and answers queries over it. Measured on WordPress 7.1.3 with Joern v4.0.653: the PHP graph for 1,516 files builds in about 30 to 60 seconds at about 6 GB of memory, a fixed export of methods and call sites runs in about 30 seconds, and individual queries take milliseconds. The PHP call graph is incomplete: a free function called from inside a class resolves to a nonexistent class method (Joern issue 3050), so only 11 of the 25 `wp_insert_post` call sites resolve; array callbacks such as `array($this, 'method')` are split into temporary assignments; `parent::`, late static binding, variable calls, and computed hook names stay unresolved. PoC files inside the target that redefine WordPress functions captured calls such as `check_ajax_referer` until they were excluded.

## Decision

Joern supplies facts; the model names and groups features; the harness checks the model's feature claims against the facts.

- **Joern facts are evidence, never a verdict.** Every call edge carries its source (`joern`, a harness repair, `grep`, or a model citation the harness resolved at the pinned commit). A missing Joern edge never refuses a model claim on its own; a claim outside the graph must cite the call site instead.
- **Facts come from the pinned commit.** `hard-cpg` exports the pinned snapshot with `git archive`, runs the PHP frontend and one packaged query script through the shell seam, and caches the JSON Lines output per commit and query digest beside the snapshot store, so facts and citations describe the same content.
- **Only packaged queries run.** Joern's interpreter executes arbitrary Scala and its server mode is not a security boundary, so neither the model nor any tool argument reaches Joern; the harness runs the packaged script with harness-built parameters.
- **The export is framework-neutral.** The script emits files, internal methods, and call sites with resolved targets and bounded argument summaries, including the values of desugared array literals. Framework knowledge such as WordPress hooks, REST routes, and capability checks belongs to a later profile over these facts, not to the Scala query.
- **Exclusion is explicit.** `excludePaths` defaults to empty, matching the mission's whole-commit denominator; a deployment whose snapshot holds PoC stubs excludes them by path.
- **The deployment installs Joern.** The bundle mounts `hard-cpg` switched off; enabling it requires `joernHome`, and the build script does not download the 1.7 GB distribution.
- **PHP first.** The first export targets the PHP frontend because the measured mission was WordPress; other frontends join with their own measurements.
- **Repairs are rules over the facts, each tagged.** `hard-featuremap` adds an edge for a call Joern left unresolved only when the facts name exactly one target, and tags it `repair` (type lineage, relative calls, the issue 3050 class-qualified free function), `unique-name` (a dynamic call whose method name only one method carries), or `hook` (a literal hook firing to its registered callbacks). On WordPress 7.1.3 this links all 24 `wp_insert_post` call sites that grep finds.
- **The feature map database is derived.** One SQLite file holds every project and snapshot, keyed by target root, commit, and a derivation digest; because facts can always be imported again, a file stamped with another schema version is dropped and rebuilt instead of migrated.

## Alternatives considered

- **A model-only feature map.** Rejected as the base: listing callers by reading costs most of the budget and leaves the harness nothing to check completeness against.
- **Joern's own interface or a Neo4j export for the map view.** Rejected: Joern has no web interface, and its exports show syntax and flow nodes, not features, state, and authorization, and cannot link to ledger records.
- **Letting the model query Joern directly.** Rejected: an interpreter that runs arbitrary code is not a tool argument the harness can confine.
- **tree-sitter symbol extraction.** Deferred: lighter and multi-language, but it yields no call resolution or data flow; it stays a fallback for languages Joern reads poorly.
- **Repairing Joern's PHP call resolution in Scala.** Rejected: repairs live in TypeScript over the exported facts, where per-file coverage and fixtures test them.

## Consequences

- An enabled deployment needs JDK 21, PHP on the path for the PHP parser, about 3.5 GB of disk for Joern, and memory on the order of 6 GB for a WordPress-sized target.
- Each export step runs under the shell's per-command timeout cap; a target larger than WordPress may need a higher `maxTimeoutMs` on the shell.
- The feature map is only as complete as the graph plus citations; the completeness check is strict for edges the graph sees and asks for citations elsewhere.
