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

`runs` (1 to 10) is the exploit-arm execution count, `timeoutSeconds` (1 to 3600) caps each run, `stdoutMaxBytes` bounds captured stdout, and `pocWorkdir` overrides the working directory; without it the PoC runs from the armed matrix's pinned target repository so the model-relative `pocPath` resolves in the code it claims about. The benign arm always runs first, once, on the clean tree. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-verifier) is the exhaustive source for every accepted field. A confirmed root cause rejects duplicate proposals with `HARD_VERIFIER_DUPLICATE` without executing anything.

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
- **Effect-class refinement deferred** — sanitizer-signal and differential-check classification for memory-safety and authz classes land with the coverage auditor; the marker contract is the single PR2 contract.
- **Absence-shaped classes refuse batch screens** — `ABSENCE_SINK_CLASSES` (`authz`, `authn-bypass`, `login-bypass`) name protective checks, so `screenModules` refuses them: there, an empty grep means no guard was found, which is suspicious rather than clean. The batch union also means a model's patterns can only add coverage over the fixed table, never subtract.
- **Network policy is the deployment's** — egress restriction during PoC runs follows the mounted sandbox provider; the verifier does not add its own policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
