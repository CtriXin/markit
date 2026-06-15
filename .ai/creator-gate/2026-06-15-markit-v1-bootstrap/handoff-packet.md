# Handoff Packet

## Source Priority

User correction > `docs/implementation-plan.md` > repo/global rules.

## Raw Requirement Record

See `raw-requirements.md`.

## Source Cache

See `source-cache-manifest.json` and `cache/implementation-plan.md`.

## Project Setup Intake

See `project-setup-intake.md`.

## Existing Implementation Overlay

Not applicable; fresh repo.

## Internal Grill Status

PASS; see `internal-grill-report.md`.

## Source Priority / Conflict Status

PASS; no unresolved conflicts.

## Target Scope

Bootstrap `0.1.0` through `2.6.0`.

## Contract Artifacts

See ledger, structure/data/behavior/design contracts.

## Product Alignment Status

No blocking open questions for bootstrap.

## Execution Strategy

Create workspace, server health, web shell, fixture, pixel probe, validation commands.

## Trace Matrix Summary

`R-0.1.0` through `R-0.5.0` implemented; `R-V1` future.

## Framework Instructions

Keep package boundaries: web UI only, server local API/runtime only, contracts shared DTO only.

## Designer Instructions

Use warm Markit token system; no purple gradient/glass/AI hero/backend table slop.

## WriteEngine Instructions

Not triggered. Preserve exact short labels from plan.

## Integration Instructions

Do not add later CRUD/AI/export until bootstrap gates pass.

## Drift Status

PASS; see `contract-drift-report.md`.

## Acceptance Commands

`pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm probe:pixels`, frontend-baseline check, rendered Playwright smoke.

## Open Questions

None for bootstrap.

## Evidence Requirements

Record command outputs, rendered smoke result, baseline result.
