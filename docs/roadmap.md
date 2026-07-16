# Roadmap — remaining PRs to RFC completion

Forward plan for every PR between current `main` and "the RFC is done." Sizing
and cut-line method: [`pr-decomposition-method.md`](pr-decomposition-method.md).
Carve/rebuild mechanics: [`preview-workflow.md`](preview-workflow.md).

The RFC is the canonical contract:
`HathorNetwork/rfcs` → `projects/hathor-wallet-lib/0000-integration-test-helper.md`.

## Current state

| Stage | Work |
| --- | --- |
| Merged to `main` | wallet endpoints + server, wallet-provider drop-in (`FUNDING_ENABLED=false`), Docker image, action pins, genesis lifecycle + readiness (#10), UTXO reservation pool (#13) |
| Queued (decided, imminent) | **P1** primitives + readiness (~120 prod) → **P2** pool production (~330) → **P3** `/fund` endpoint (~400). Strictly linear; carved from `preview/final-state` |
| North-star tip (meta, never in feature PRs) | process docs: preview-workflow, decomposition-method, pr-descriptions, review-rules, this roadmap |

After P3 the service is behaviorally RFC-complete.

## RFC-vs-built verdict

**The RFC's normative surface is fully covered by `main` + the three queued
`/fund` PRs, with one concrete gap.** A section-by-section audit (2026-07-16)
confirmed all fourteen config vars, the full error schema and codes,
`X-Test-Name` correlation, stale-UTXO recovery, auto-refill, and the four
race-freedom invariants are present in code. What remains is verification and
documentation, not service logic:

1. **Reference compose stack** (§4.10, second half) — genuinely specified,
   genuinely absent. Only the `Dockerfile` exists; there is no
   `docker-compose.yml` wiring helper + fullnode + tx-mining with health-gated
   startup.
2. **No end-to-end proof.** Every test on the branch is a DI-faked unit test;
   nothing exercises a real fullnode + tx-mining-service. The RFC's whole
   point (§2.3, §4.3.4) is behaviour under a real stack.
3. **RFC ↔ code reconciliation.** Four deliberate, review-driven deviations
   exist — single-bucket wallet-sourced pool (§4.3), multisig response shape
   (§4.6.2), `/status` (200 diagnostic) split from `/ready`/`/live` probes
   (§4.6.4), defaulted `GENESIS_SEED_WORDS` (§4.12). The code is the *reviewed*
   improvement in each case; the contract should move to match it, not the
   reverse. Needs a human call (decision A).
4. **OpenAPI document** — the merged README promises one; still owed.
5. **Process docs destination** — see PR "process docs" below.

§9 "future possibilities" (custom tokens, cached multisig, multi-node, …) are
explicitly non-normative and out of scope unless greenlit (decision D).

## Forward PR plan

Numbering picks up after the three `/fund` PRs (P1–P3).

**PR 4 — compose stack + e2e smoke** *(merged: deployment topology and its
minimal tripwire ship together)*
- `docker-compose.yml` + privnet config: one `docker compose up` gives helper
  + hathor-core privnet + tx-mining-service, the helper's `/ready` healthcheck
  gating dependents — the RFC's prescribed consumption shape (closes the §4.10
  gap).
- A **smoke** CI job that boots the stack and drives the happy path (poll
  `/ready`; `simpleWallet`; `multisigWallet`; a standard `/fund` and a large
  `/fund`; one 409 semantics case). Proves the stack boots and the real path
  works — not a substitute for the full suite.
- ~200–300 prod lines. All-new files; no `src/` change.
- **Gate before carving (decision C):** confirm pinnable hathor-core +
  tx-mining images and dev-miner availability (§4.11); otherwise decide
  cpuminer-sidecar vs generous timeouts.

**PR 5 — full integration test suite** *(its own considerable PR)*
- The comprehensive end-to-end suite against PR 4's stack: every error code,
  each of the four race-freedom invariants observed under real WS propagation,
  auto-refill below threshold, stale-UTXO rescan-and-retry, parallel-funding
  race freedom, reward-lock timing. This is the real proof the DI fakes only
  approximate.
- Substantial by design — review-size discipline applies to tests, so this is
  a first-class PR, not smuggled into PR 4. See the "tests get their own
  considerable PR" section of the decomposition method.
- Depends on PR 4 (needs the stack + harness).

**PR 6 — OpenAPI spec** — the canonical `docs/openapi.yaml` the README
promises (7 endpoints, error schema, `X-Test-Name`, `/status` body). Docs
bucket; depends on the final surface (post-P3).

**PR 7 — RFC amendment** *(in the `HathorNetwork/rfcs` repo; decision A)* —
fold the four reviewed deviations into the contract so "deviations are bugs"
holds again. Prose only; different repo.

**PR — process docs extraction** *(in the target repo, not this one)* — the
north-star process toolkit (`preview-workflow.md`, `pr-decomposition-method.md`,
`pr-descriptions.md`, `review-rules/`) is being lifted into another repository
to run this same north-star process there. It is kept well-documented and
self-contained on this branch precisely so it extracts cleanly. Whether these
docs also merge to *this* repo's `main` (vs staying north-star-tip-only) is
decision B.

## Parallelization

The `/fund` PRs (P1 → P2 → P3) are **strictly sequential** — no parallelism.
After P3 merges, the work fans into one spine and independent side-tracks:

```
spine (same repo, linear queue):
  P3 ──▶ PR4 compose + smoke ──▶ PR5 full integration suite

side-tracks (parallel — no shared code seam, startable independently):
  ├─ PR6 OpenAPI spec        (this repo, docs; needs final surface = post-P3)
  ├─ PR7 RFC amendment       (rfcs repo; documents already-decided design —
  │                           can start now, before P3 even merges)
  └─ process-docs extraction (other repo; the docs already exist — start now)
```

- **PR 5 gates on PR 4**, always — the full suite needs the stack and harness
  PR 4 builds. That is the one hard sequence in the tail.
- **Cross-repo work is fully parallel.** The RFC amendment (rfcs repo) and the
  process-docs extraction (target repo) touch no ITH code and no ITH carve
  queue, so they run alongside everything — and both document things already
  decided, so neither needs P3 merged first.
- **Same-repo docs (PR 6) are parallelizable in principle** but the north-star
  workflow prefers one carved slice at a time; keep it in the linear queue
  unless schedule pressure justifies a second open PR.

Net: after `/fund`, only **PR4 → PR5** must be sequential; the three
documentation efforts can all proceed in parallel, two of them immediately.

## Open decisions

- **A. RFC amendment vs code revert** for the four reviewed deviations.
  Recommendation: amend the RFC (PR 7) — reverting the code would reintroduce
  the drift-bug class #13's review removed. Needs an explicit call because
  CLAUDE.md currently says deviations are bugs.
- **B. Do the process/meta docs merge to `main`,** or stay north-star-tip-only
  and extraction-only?
- **C. e2e feasibility in CI** — pinnable images + dev-miner — resolve *before*
  carving PR 4.
- **D. Greenlight §9 items** (custom-token funding first — the most likely ask,
  since wallet-lib integration tests mint tokens constantly). If approved, ship
  as three PRs (token primitives → `/fund` token param → docs + e2e case),
  never one; ~450 combined prod lines is a monolith waiting to happen.
