# Execution Strategy

result: PASS

## Solution Path

Implement the smallest runnable Markit skeleton: pnpm workspace, Express health API, Vite shell, fixture site, CSS pixel probe.

## Target Layers And Files

- root workspace files
- `apps/server`
- `apps/web`
- `packages/contracts`
- `packages/annotation-core`
- `packages/ai-normalizer`
- `packages/issue-sinks`
- `fixtures/test-site`
- `docs/baseline-capability-ledger.md`

## Owner Split

Single executor in this turn; future x.y.z can split by package.

## Forbidden Shortcuts

- Do not claim full V1 complete.
- Do not skip pixel probe.
- Do not send screenshot/model data externally.
- Do not use rendered DOM as contract source.

## Validation Map

- workspace -> `pnpm install`, `pnpm typecheck`
- tests -> `pnpm test`
- production bundle -> `pnpm build`
- pixel invariant -> `pnpm probe:pixels`
- UI smoke -> Playwright rendered smoke
- baseline -> `check_baseline.py`

## Blast Radius And Rollback

Bootstrap only; no migrations or external state. Rollback is limited to uncommitted files in this repo plus Playwright browser cache install.
