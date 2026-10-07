---
kind: upgrade-guide
description: "The hard mission stops excluding trees by default, refuses a first arming over a drifted working tree, and no longer accepts batch screens as audited coverage."
---

# Hard mission audits the whole pinned commit

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, `hard-mission` dropped `node_modules`, `vendor`, `dist`, `build`, `docs`, `doc`, `locales`, `i18n`, `assets`, `fixtures`, `testdata`, `__snapshots__`, and minified bundles from the coverage matrix unless `target.excludeGlobs` said otherwise, and listed tracked files from the index. Gettext catalogs (`.po`, `.pot`, `.mo`) screened as inert. A completion could rest on batch-cleared cells alone.

The next release changes four behaviors that anyone running the hard bundle observes:

- `target.excludeGlobs` defaults to `[]`. The matrix enumerates every file the pinned commit tracks, so the same target produces more modules. A configured exclusion is recorded in `hard/mission/armed` and reported beside the coverage ratio.
- The first arming of a fresh root agent fails when a tracked file differs from the pinned commit or an untracked, unignored file exists: `hard mission: target working tree differs from the pinned commit`. The project-local `.dsh/` directory and a DSH home inside the target are exempt. A resumed session never re-checks.
- Gettext catalogs count as code, so a module holding them no longer screens inert.
- Batch screens (`model-verified` cells from `hard_clear_modules`) no longer satisfy the completion requirement for a model-audited cell, and `hard_clear_modules` refuses modules the harness cannot screen — any module holding a binary or a file outside the JavaScript and TypeScript family, Python, and Java.

## Migration

1. Decide what the mission should skip and write it explicitly in the profile patch, for example `target: { excludeGlobs: ['vendor/**', 'dist/**'] }` under the `hard-mission` entry. Leave the list empty to audit everything.
2. Commit or remove local changes in the target repository before starting a mission; add generated output to `.gitignore`.
3. Expect missions to read cells individually in modules the harness cannot screen; a run that only batch-screens must also record at least one per-cell read or resolved hypothesis to complete.
4. Confirm: the session's `hard/mission/armed` event carries `unscreenedModules`, `ignoredEntryCount`, and, when you configured globs, `exclusions` with the excluded file count.
