---
description: "Use the experimental Web coverage-matrix panel for hard-harness sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-hard

English | [中文](README.zh.md)

## Summary

This package adds a right-sidebar tab to the Web client for hard-harness sessions: the armed coverage matrix as a module × bug-class grid, the coverage ratio, the pinned target, and the completion gate's current assessment. It reads the Session's `hardLedger` projection from the shared Session store, where Host projection frames keep it current, and every cell shows its verdict together with who decided it, so a machine screen never reads as a model's own sweep. The browser projection does not extend the stable API Proxy or register model-facing input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Switch the hard bundle on for a Web-composition profile: the bundle mounts this panel beside the nine hard plugins, and only there — a headless composition disables the row. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Open the panel

The guide tab in the right sidebar lists a Hard coverage capsule; picking it opens the coverage page in that tab's place. The panel needs no refresh control: projection frames update the matrix while it stays open.

### Read the matrix

Rows are the armed modules, columns the armed bug classes — both are session data and stay untranslated. Each cell's color names verdict and decider together: blue for a cleared cell the model read itself, green for a batch clear the harness grep confirmed, neutral gray for the inert-module screen, red for a cell the harness cross-check reopened, amber for a suspicious call the model made on its own, and a hollow outline for cells without a verdict. Hovering a cell names its module, class, verdict, and decider. The header shows the ratio, the target repository with the pinned commit, and the gate: certified, or open with the first blockers listed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries, one sidebar tab type (stage one of the two-stage tab registration), and the keyed `sidebar.right.pane.tab` body (stage two) through Cordis effects. Disposing the plugin fiber removes all three, and the builtin guide resumes.

The component derives everything from the `useSessions` seat: the view comes from `projectionsBySession[sessionId].values.hardLedger`, the wire summary the hard-ledger projection publishes — matrix axes, latest per-cell verdicts with sources, the coverage aggregates, and the gate assessment. Without a projection value the panel shows a loading notice while the baseline reads and an empty notice afterward; with a projection but no arming record it shows the same empty notice. Faces are pure CSS classes over shared state tokens; tooltips are the shared primitive.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, tab-type, and slot registrations |
| [`src/client/CoverageMatrix.tsx`](src/client/CoverageMatrix.tsx) | Projection-derived matrix, header, and legend |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Hard bundle](../hard-bundle/README.md) — the layer that mounts this panel on Web compositions.
- [Hard ledger](../hard-ledger/README.md) — the projection and its client wire view.
- [Right sidebar](../../client/ui-sidebar-right/README.md) — the tab registry and keyed tab-body seat.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the hard tools own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Coverage only** — findings, hypotheses, and round progress are later panels; the matrix is the first surface.
- **No transcript cards** — the `hard/*` events stay out of the conversation; the panel is the reading surface.
- **Late plugin activation** — after enabling the hard bundle in an already-open conversation, reload the page to receive its `hardLedger` projection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
