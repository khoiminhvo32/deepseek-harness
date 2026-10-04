---
description: "The hard-verifier plugin for hard-harness deployments executing findings' proofs of effect and recomputing their CVSS 4.0 scores."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-verifier

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-verifier` executes a finding's proof of concept through the shell seam and decides its verdict mechanically: a run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout. All runs passing confirms, all failing refutes, any split is flaky and never counts. The engine recomputes the claimed score from the CVSS 4.0 vector using data and logic vendored verbatim from the FIRST reference calculator.

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

`runs` (1 to 10) is the per-verification execution count, `timeoutSeconds` (1 to 3600) caps each run, `stdoutMaxBytes` bounds captured stdout, and `pocWorkdir` optionally overrides the working directory. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-verifier) is the exhaustive source for every accepted field. A confirmed root cause rejects duplicate proposals with `HARD_VERIFIER_DUPLICATE` without executing anything.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **The model never accepts its own proof.** Verification runs the PoC through the shell seam with the configured timeout; acceptance requires the deterministic `HARD-PASS <claimHash>` marker bound to the claim text, so a fabricated finding cannot satisfy the contract without actually running a working exploit.
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
- **Network policy is the deployment's** — egress restriction during PoC runs follows the mounted sandbox provider; the verifier does not add its own policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
