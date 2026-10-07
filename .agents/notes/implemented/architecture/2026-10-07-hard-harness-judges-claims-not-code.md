# Agent Note: The hard harness judges claims, not code

Status: implemented

English | [中文](2026-10-07-hard-harness-judges-claims-not-code.zh.md)

## Problem

The hard harness exists to keep a model working until a mission is genuinely complete. A model stops by claiming it is done — "I swept everything and found nothing" — so the harness's only leverage is refusing a completion claim, and it can refuse only what it can check.

The coverage cross-check grepped a module against fixed sink tables and read an empty grep as clean. Run against one PHP file holding five real WordPress holes (no capability check, SQL built into `$wpdb->get_results`, `include $_GET`, an arbitrary file write, `passthru`), every class's patterns matched nothing, and `hard_clear_modules` would have recorded every cell as `model-verified`: full coverage, no finding, harness attribution, on vulnerable code. All three verifier greps also pass `-I`, which skips binary content whatever the extension, so a shared library read as clean too. Separately, the default exclusion globs dropped `vendor/`, `dist/`, `assets/`, and other trees that ship to production, and the arming record never said so, so a coverage ratio could stand on a silently shrunk denominator.

## Decision

The harness judges claims, not code. The model finds bugs; the harness refuses a completion claim it cannot back, and never certifies what it did not check.

- **Findings and clears are asymmetric.** A finding carries a machine-checkable artifact — the PoC, its marker, the benign arm — and stays `demonstrated`, never `proven`, because the model writes the PoC. A clear has no machine witness in any language, so the harness does not certify one.
- **A grep can only accuse.** A match the model did not declare re-opens the cell; an empty grep is silence. `model-verified` therefore means a batch screen — cells the model cleared without reading while a grep found nothing — the weakest model tier, and the completion assessment's audit floor counts only individually decided model cells and resolved hypotheses.
- **Screenability is a recorded property of each module.** At arming, `hard-mission` lists the pinned commit's files through a numstat diff against the empty tree, which also marks binaries. A non-inert module holding a binary, or a file whose extension `SCREENED_EXTENSIONS` (the verifier's table, written for the JavaScript and TypeScript family, Python, and Java) does not cover, is recorded in `unscreenedModules`. Classification reads content as well as extension because `grep -I` does. `hard_clear_modules` refuses such a module before any grep runs, and a model clear there counts as a blind clear in the ledger, the gate decision record, the panel, and the pilot report.
- **The denominator is the whole pinned commit.** `excludeGlobs` defaults to empty; an exclusion is the deployment's explicit choice, recorded in the arming event with a count and a bounded sample and reported beside the ratio. The 500-row cap advises a coarser `moduleDepth`, never dropping code.
- **The pinned commit is the content the model saw.** The harness captures the target into a snapshot it owns, so the matrix and every citation resolve against what the model saw at arming; [the snapshot decision](2026-10-07-hard-harness-pins-any-target.md) replaced the earlier refusal of a drifted working tree.
- **A per-cell clear must cite code that exists.** Real models clear cell by cell, so that path carries the cost: a `cleared` verdict cites each inspected site as `path:symbol`, `path:line`, or `path:start-end`, and the verifier resolves every site at the pinned commit with git alone before the record exists. This is an anti-fabrication floor, not a proof of the clear — a symbol can sit in a comment — and the cross-check matches its grep lines against citations by path and symbol or line instead of by substring.
- **The model can read the board it is pushed through.** Every hard tool but one writes; the steering names five uncovered cells and a rejection names twelve rows, which on a large repository turns pressure into guessing. `hard_status` reads back the per-kind open-work counts, the gate, the matrix axes, and a bounded page of board cells or open-work items. It returns counts, never a coverage ratio: a salient progress number in front of a pressured model invites clearing cells for the number's sake.

- **An independent reader is the clear's only witness, and it is independent, not mechanical.** `hard-audit` samples model clears by tier — inverse to what the cross-check can screen — and spawns a fresh reader that is blind to claims, not to code: it gets the target, the commit, the cell, and a neutral class definition and may read the whole repository, because authorization and injection flows cross modules, but never the verdict, declared sites, notes, flow documents, hypotheses, findings, or other audits. A same-family reader shares the mission model's blind spots and a different family narrows them without removing them, so a corroboration stays a measurement, never `proven`. Its first form is a shadow: results are recorded beside the clear and reach neither the mission agent nor the gate until cost and flag rates are measured.
- **Blindness is checked after the fact, not enforced by the filesystem.** The reader works in a temporary worktree of the pinned snapshot, but its read tools can open any path, including the live target with the mission agent's PoCs and the session logs holding its claims. Every path argument the reader passed must resolve inside its worktree, or the result is `contaminated` and drops out of the measurement. The reader's report counts only when its sites resolve at the pinned commit.

## Alternatives considered

- **Per-language pattern packs for PHP, Go, Rust, and others.** Rejected as the route to correctness: it makes the harness a better bug finder, which is the model's job, and scales with languages times classes while always trailing them. Once a missing pack is recorded as unscreened instead of read as clean, a pack is an optimization.
- **A vacuity check on the model's batch patterns** (they must match something somewhere in the repository). Rejected as a trust gate: one pattern matching an unrelated string in another module passes it, the same one-more-line defeat as the echo trap and the negative-control ladder.
- **Requiring the model's patterns to match the sinks it declared.** Rejected: the model's artifacts agreeing with each other proves nothing.
- **Language servers in the harness.** Rejected for the harness: an LSP reports symbols and references, not taint. It belongs in the toolbox of an LLM reading code.
- **A read-confining filesystem capability for the reader.** Deferred: confining `read` through the filesystem seam and `glob`/`grep`, which run ripgrep directly, changes core seams for a risk no run has shown, while a shadow measurement only needs a contaminated read to be detected and voided. It returns when audit results bind the gate.
- **A fork provider or the mission agent re-reading its own cell.** Rejected: a fork inherits the conversation that holds every claim, and the same model in the same context agrees with itself.
- **A recorded-session snapshot of the audit.** Rejected: the reader runs concurrently with the mission agent, so the interleaving of audit records in the mission log is not deterministic; a real-composition end-to-end test covers the path.

## Consequences

- On a language the tables do not cover, the harness now reports "N blind clears" instead of "100% verified". That is less coverage on paper and an honest one.
- Fail-closed classification is strict: a root module with `package.json` or `.gitignore`, or a frontend module with `.css`, is unscreened, so batch screens are unavailable there and the model reads cells individually.
- Missions over targets with vendored trees cost more; the cost is visible and the exclusion is one configured glob away.
- Each audit is a cold-context reader run that does not share the mission agent's prompt cache, so the budget is explicit and conservative by default, and the plugin ships switched off.
- A one-shot headless run exits when the mission agent idles, which lost every audit of the first pilot, so an idle mission agent with audits in flight holds its maintenance slot until they settle; audits therefore lengthen the mission's wall-clock time without changing what it sees.
- One direction remains: a binary track whose crash oracle the harness observes itself — the first structural path to a witness the harness sees rather than one the model writes.
