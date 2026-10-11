---
description: "Use the experimental Web coverage-matrix and feature-map panels for hard-harness sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-hard

English | [中文](README.zh.md)

## Summary

This package adds two right-sidebar tabs to the Web client for hard-harness sessions. The coverage tab shows the armed module × bug-class matrix, the coverage ratio, the pinned target, and the completion gate; each cell shows its verdict and who decided it. The feature map tab graphs the target's entry points, the features the model recorded, and their links, and opens any feature's symbol graph and any symbol's call edges and source. Both read the Session's `hardLedger` projection, which Host projection frames keep current. Neither extends the stable API Proxy or registers model-facing input.

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

While the panel is mounted, the sidebar brand reads Meebard Harness instead of the local-build fallback. Switch the hard bundle on for a Web-composition profile: the bundle mounts this panel beside the nine hard plugins, and only there — a headless composition disables the row. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Open the panel

The guide tab in the right sidebar lists a Meebard coverage matrix capsule and a Meebard feature map capsule; picking one opens that page in the guide tab's place. Neither panel needs a refresh control: projection frames update them while they stay open.

### Read the matrix

Rows are the armed modules, columns the armed bug classes — both are session data and stay untranslated. Each cell's color names verdict and decider together: blue for a cleared cell the model read itself, green for a batch screen the model cleared without reading, neutral gray for the inert-module screen, red for a cell the harness cross-check reopened, amber for a suspicious call the model made on its own, and a hollow outline for cells without a verdict. A corner dot marks a model clear in a module the harness cannot screen, where nothing but the model's read stands behind the verdict; the mark overlays the color instead of replacing it. Hovering a cell names its module, class, verdict, decider, and any mark. The header shows the ratio, the target repository with the pinned commit, the gate (certified, or open with the first blockers listed), and the blind-clear count when there is one; a line below it states how many tracked files a configured exclusion removed.

### Read the feature map

The feature map tab appears once the mission indexes the target with `hard-featuremap`. The header counts features, mapped entry points out of all indexed ones, and feature links; a collapsed list below the graph names every entry point no recorded feature covers. Until the model records a feature, the overview graph lists every indexed entry point in one column per entry kind (ajax, rest, script, and so on). Once features exist it groups by feature: each feature is a cluster with up to six of its entry points below it and a count for the rest, clusters sit in a three-column grid in record order, an animated edge joins each recorded feature link, and one dashed node beside the grid counts the entry points no feature covers and opens their list. Clusters have a fixed size, so a new feature lands after the ones already drawn, and a node that appears while the tab is open carries a green ring and a "new" tag for four seconds.

Picking a feature, from the chip row or its node, shows its summary, reach, required and excluded counts, and recorded state, and replaces the overview with the feature's symbol graph from the Host: handlers in the first column and each further call level in the next, excluded symbols dimmed in the last column, guards and state writes outlined, and edges colored by the rule that made them (Joern, repair, unique name, hook). A revised feature record refetches the graph. The header counts guard pairs still open, a dashed red edge joins two features the harness linked over a guard pair, a feature node marks a finished abuse review, and an open feature lists its review state and every pair it takes part in with how it was closed. Picking a symbol lists its callers and callees, each of which opens in turn, and shows its lines at the pinned commit. "All features" returns to the overview.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries, two sidebar tab types (stage one of the two-stage tab registration), and their keyed `sidebar.right.pane.tab` bodies (stage two) through Cordis effects. Disposing the plugin fiber removes all of them, and the builtin guide resumes.

The component derives everything from the `useSessions` seat: the view comes from `projectionsBySession[sessionId].values.hardLedger`, the wire summary the hard-ledger projection publishes — matrix axes, latest per-cell verdicts with sources, the coverage aggregates, and the gate assessment. Without a projection value the panel shows a loading notice while the baseline reads and an empty notice afterward; with a projection but no arming record it shows the same empty notice. Faces are pure CSS classes over shared state tokens; tooltips are the shared primitive.

The feature map reads `featureMap` from the same view and draws it with React Flow, which the Client bundle inlines. Its layouts are pure functions of record order. The feature graph and symbol detail come from `GET api/hard-featuremap.feature` and `GET api/hard-featuremap.symbol`, which `hard-featuremap` registers on the Web connection; the panel imports only that package's `./client` types, keeps its own copies of the two paths, and a test compares them with the Host constants. A response that arrives after the selection changed is dropped.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, tab-type, and slot registrations |
| [`src/client/CoverageMatrix.tsx`](src/client/CoverageMatrix.tsx) | Projection-derived matrix, header, and legend |
| [`src/client/FeatureMap.tsx`](src/client/FeatureMap.tsx) | Feature map overview, feature graph, and symbol detail |
| [`src/client/feature-layout.ts`](src/client/feature-layout.ts) | Pure graph layouts and the Host route paths |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Hard bundle](../hard-bundle/README.md) — the layer that mounts this panel on Web compositions.
- [Hard ledger](../hard-ledger/README.md) — the projection and its client wire view.
- [Hard feature map](../hard-featuremap/README.md) — the feature map and the routes the feature map tab reads.
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

- **Coverage and features only** — findings, hypotheses, and round progress are later panels.
- **Feature map needs a live agent** — the feature graph and symbol routes answer only while the session's agent runs; a reopened finished session shows the overview but not the graphs.
- **No cross-project page** — the feature map database is shared across projects, but the tab shows one session's target only.
- **No transcript cards** — the `hard/*` events stay out of the conversation; the panel is the reading surface.
- **Late plugin activation** — after enabling the hard bundle in an already-open conversation, reload the page to receive its `hardLedger` projection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
