---
description: "The hard-verifier plugin for hard-harness deployments executing findings' proofs of effect and recomputing their CVSS 4.0 scores."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-verifier

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-verifier` executes a finding's proof through the shell seam and decides the verdict. The proof runs in two arms: the benign arm re-runs the PoC once with a benign payload and must fail (the specificity check — a proof that passes regardless of input proves nothing about the input); then the exploit arm runs the model's payload, where a run passes only at exit zero with `HARD-PASS <sha256 of claim>`. All exploit runs passing confirms, all failing refutes, any split is flaky and never counts. The claimed CVSS 4.0 score is recomputed with vendored FIRST logic.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the hard ledger; the tools call `ctx.hardVerifier.verify` after proposing a finding.

```yaml
- id: hard-verifier
  name: '@deepseek-ai/dsh-experimental-hard-verifier'
  config:
    runs: 3
    timeoutSeconds: 120
```

`runs` (1 to 10) is the exploit-arm execution count, `timeoutSeconds` (1 to 3600) caps each run, `stdoutMaxBytes` bounds captured stdout, and `pocWorkdir` overrides the working directory; without it the PoC runs from the armed matrix's pinned target repository so the model-relative `pocPath` resolves in the code it claims about. The benign arm always runs first, once, on the clean tree. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-verifier) is the exhaustive source for every accepted field. A confirmed root cause rejects duplicate proposals with `HARD_VERIFIER_DUPLICATE` without executing anything. `assertVerifiable` runs that check and the vector parse (`HARD_VERIFIER_INVALID_VECTOR`) before a caller appends the proposal, so a claim the verifier could never decide never stays pending.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **The proof must depend on the payload.** Verification runs the PoC through the shell seam with the configured timeout; acceptance requires the deterministic `HARD-PASS <claimHash>` marker bound to the claim text and a failing benign arm (the specificity check). No stdout shape is demanded beyond the marker — a silent exploit whose effect stays off stdout confirms — while a PoC that prints filler plus the marker for any input is refuted as not payload-specific. Every refuted verdict names its cause — `benign-arm-passed`, `no-marker`, `nonzero-exit`, `timeout`, `aborted`, or `no-runs` — so runs aggregate into protocol, target, and infrastructure failure groups.
- **Reference-identical CVSS.** `src/cvss4-lookup.ts` vendors the FIRST calculator's macrovector scores, composed maxima, and severity depths verbatim (BSD-2-Clause); `src/cvss4.ts` ports its scoring algorithm one-to-one. The exhaustive suite scores all 270 macrovectors' highest-severity vectors exactly at their lookup values, so drift from FIRST fails loudly.
- **Deterministic dedup.** `rootFingerprint` hashes normalized bug class, component, and containing symbol; `claimHash` hashes the claim text and is what the PoC must print.
- **Durable verdicts.** Every verification appends a `hard/finding/verdict` record through the ledger, including the recomputed score and whether the model's claimed score matched.

### Source map

| File | Role |
|---|---|
| [`src/cvss4-lookup.ts`](src/cvss4-lookup.ts) | Official FIRST lookup data, vendored verbatim |
| [`src/cvss4.ts`](src/cvss4.ts) | Typed port of the reference parsing and scoring algorithm |
| [`src/fingerprint.ts`](src/fingerprint.ts) | Claim hash and root-cause fingerprint |
| [`src/verdict.ts`](src/verdict.ts) | Proof-of-effect contract and verdict classification |
| [`src/index.ts`](src/index.ts) | `HardVerifier` service: duplicate rejection, execution, CVSS recompute, recording |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the service executes proofs and records verdicts; the tools consumer owns all model-visible results, whose submit JSON carries the verdict, run count, recomputed score, score match, and a bounded reason.

#### KV Cache effect

Results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bash PoCs** — execution runs `bash <pocPath>`; Windows PoC runners need the pwsh provider path, deferred.
- **Flow-citation resolution** — `checkFlowCitations(agent, citations)` resolves each `path:line` cite against the pinned commit through `git ls-tree` and `git show`, never the working tree: the path must be tracked at the commit, the lines must exist, and the snippet must appear in their content. It fails closed on an unsettled git call and returns the rejected cites with reasons, so `hard_record_flow` can refuse the whole document naming every failed cite.
- **Declared-site resolution** — `checkSinkCitations(agent, sinks)` resolves each declared site of a cleared coverage cell, written `path:symbol`, `path:line`, or `path:start-end` with an optional note, at the pinned commit through git alone — `git ls-tree`, a numstat diff against the empty tree, `git grep -I -F`, and a line count — so the outcome does not depend on the host's `grep`. A binary passes the path check without its content being read as resolved, because its module is unscreened. A symbol can match inside a comment: this refuses citations of code that does not exist, not wrong clears. The coverage cross-check matches its grep lines against citations by path and symbol or line, and keeps the substring rule for declarations that are not citations. Like the batch screen, it runs `git grep -I -n -E` over the pinned commit, never the working tree, so a report, PoC, or edit written into the target after the arming neither reopens a cell nor names a line the model could not cite. It greps a module's directory, only the files at the root for the root module `.` (`--max-depth 0`), and the whole tree for a repository-scoped class, and drops the `<commit>:` prefix so its paths compare with citations. A reopening lists at most eight undeclared matches and closes with a count of the rest.
- **Effect-class refinement deferred** — sanitizer-signal and differential-check classification for memory-safety and authz classes land with the coverage auditor; the marker contract is the single PR2 contract.
- **Guarded-surface classes invert the reading** — for `authz` and `authn-bypass` the bug is the absence of a guard, so `GUARDED_SURFACE_PATTERNS` names the exported operations instead of the guard: the cross-check reopens a cleared cell naming every exported operation none of the model's declarations mention, and zero matches is silence that re-opens nothing and certifies nothing. `ABSENCE_SINK_CLASSES` keeps only `login-bypass`, whose sinks are protective checks and whose batch screens are refused: there, an empty grep is suspicious rather than clean. The batch union still means a model's patterns can only add coverage over the fixed table, never subtract. Every reopening record carries `source: 'harness'`, so reports can separate a harness reopen from the model's own `suspicious` call — finding something is correct behavior, not gaming.
- **Network policy is the deployment's** — egress restriction during PoC runs follows the mounted sandbox provider; the verifier does not add its own policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
