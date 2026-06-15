# Internal Grill Report

status: PASS

## Understanding Brief

Markit is a local URL annotation and bug capture app. The immediate task is to implement, not only document, starting with the x.y.z bootstrap slice.

## Terminology And Scope

- `session`: a local browser/page capture session.
- `capture`: screenshot + metadata + DOM targets.
- `annotation`: pin/rect/freehand/element mark on screenshot coordinates.
- Current scope: bootstrap only, `0.1.0` through `2.6.0`.

## Intent To Solution Map

- Workspace requirement -> pnpm workspace with apps/packages.
- Server health -> Express app bound to `127.0.0.1`.
- Web shell -> Vite React UI with Markit tokens.
- Pixel invariant -> Playwright `scale:'css'` probe.

## Assumption Ledger

| Assumption | Why safe |
|---|---|
| local/internal baseline | plan says local tool and no account/deploy requirement |
| no long-form WriteEngine | bootstrap has short labels only |
| later V1 slices remain future work | x.y.z plan requires stepwise delivery |

## Constraint Compiler

- server binds to `127.0.0.1`.
- Playwright screenshots use `scale:'css'`.
- `.markit/`, `.xmem/`, `node_modules/`, and `dist/` stay ignored.

## Open Questions

None for bootstrap.

## Likely Misses

- Browser plugin unavailable; rendered smoke used local Playwright fallback.
- Full capture/annotation/AI/export not implemented in bootstrap.

## Decision

Proceed; no blocking question for bootstrap.
