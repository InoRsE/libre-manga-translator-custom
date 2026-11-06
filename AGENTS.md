# MANGA-THAI — Evidence-Based Engineering Reports

This is a **workspace-wide, always-on reporting contract** for every engineering, research, QA, and delivery mission. It concerns how claims are justified; it does not add extra experiments, features, or bureaucracy.

## Non-negotiable: claim–evidence traceability

**The strength and scope of a conclusion must never exceed its evidence (claim ceiling).** Before writing the final report, independently compare every substantive success, failure, completeness, safety, quota, token, and performance claim against its original evidence.

Every material claim must state:
- **What exactly was established**, in which environment and scope.
- **Evidence type**: `LIVE_OBSERVED` (actual owner browser/provider response), `EXECUTED_LOCAL` (real command and output), `TEST_ONLY` (mock/synthetic/unit), `SOURCE_INSPECTED` (committed code), `MEASURED_COMPONENT` (actual partial measurement), `DERIVED_PROJECTION` (calculation with assumptions), or `UNVERIFIED`.
- **Traceable reference**: immutable Git commit SHA and repo-relative file:line range; command plus exit code and raw output/log path; actual HTTP status/usage metadata/attempt ledger; or source URL with access date. State which evidence is local/private and cannot be inspected from GitHub.
- **Coverage and limits**: sample N, relevant environment, excluded cases, and what was NOT tested.

A program's prose, its self-assigned verdict, a passing test name, or a self-authored fixture is not independent evidence of real behavior.

## Evidence boundaries

1. Source code existence proves **implementation**, not successful runtime behavior. Static inspection cannot certify a live browser, HTTP exchange, durable download, or actual content accuracy.
2. Mock/unit tests prove only the behaviors they actually exercised. An asserted fixture can encode the same defect as production. Show critical assertions and their relevant source paths.
3. A measurement of six individual pages is **not** a 512-page measured batch. Label extrapolations `DERIVED_PROJECTION`, with formulas and uncertainty. Never replace a missing measurement with estimated data while calling it measured.
4. For external API quotas, input/output/thinking tokens, HTTP attempts, and finish reasons: use raw provider responses/usageMetadata or exact instrumented counters. Keep distinct counters distinct; never infer a successful translation from a submitted image.
5. A complete JSON response, an image asset in cache, or a known page count does not independently prove full dialogue detection, translation quality, rendering, or user-visible offline export. Respect each gate separately.
6. `PASS`, `READY`, `VERIFIED`, `ZERO_API_CALLS`, and `COMPLETE` require directly matching evidence. Otherwise say `PARTIAL`, `NOT_VERIFIED`, or `BLOCKED` with the exact reason. Do not make the overall verdict stronger than the weakest **required** acceptance gate.
7. Failed attempts remain evidence. Report HTTP 429/503, timeouts, skipped tests, failed commands, missing assets, and residual risks without concealing them or silently retrying. Preserve true attempt counts and evidence lineage.
8. Do not invent URLs, line numbers, logs, hashes, API usage, or test results. Do not cite `file:///...` as a shareable remote reference. Do not publish secret keys, private manga bytes, raw copyrighted text, or personal paths unnecessarily.

## Required final-report structure (keep it compact)

**FINAL STATE:** One precise status with one-sentence scope and limitation.

**Claim–Evidence Matrix:** 3–8 consequential claims. For each, include `Claim | Evidence type | Exact proof reference | Coverage/claim ceiling`. Link exact code lines where available. If an artifact or raw log was not preserved, say so; do not claim independent verification.

**Observed counters:** Attempted/successful/failed/skipped operations, tests, page counts, token usage, and budget remaining, *only where observed*. Separate measured numbers from projections.

**Open boundaries:** Concrete unsupported claims, conflicting evidence, untested production behavior, and whether the next step requires a real browser/API trial.

**Reproduction:** Only the commands/inputs needed to verify key claims, plus commit SHA, test exit status and artifact locations. Never report a command as PASS if it failed or did not finish.

**Final self-audit:** Ask: “What sentence would an independent reviewer reject if they inspected only these linked files/logs?” Narrow or retract that sentence before delivering. Never use “all fixed”, “proven”, or “production-ready” for mixed or absent evidence.

When evidence is insufficient, **accurate partial progress is a successful report**. Do not run extra experiments or consume API quota merely to manufacture a PASS.
