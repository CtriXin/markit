# Evidence Manifest

status: PASS

## Command Evidence

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS, 6 workspace packages |
| `pnpm test` | PASS, 28 tests across 6 packages |
| `pnpm build` | PASS, server/packages `tsc` and web Vite build |
| `pnpm probe:pixels` | PASS, desktop-dsf1, desktop-dsf2, mobile-dsf3 |
| `pnpm e2e:tongzhang-er` | PASS, true Playwright flow with 5 bugs, 5 exports, 10 screenshots, 0 errors |
| `check_baseline.py --root . --shape static-spa --profile internal-tool` | PASS with static health/404 warnings accepted for local route-based tool |
| `validate_packet.py .ai/creator-gate/2026-06-15-markit-v1-bootstrap` | PASS |
| `review-hub dispatch via mmf overlay` | PASS, 3/3 reviewers complete, 0 incomplete |

## Implementation Evidence

- `apps/server/src/runtime/browser.ts` manages Playwright browser contexts and closes safely on shutdown.
- `apps/server/src/runtime/capture.ts` writes CSS-pixel screenshots, metadata, scroll, image size, and DOM targets.
- `apps/server/src/runtime/dom-targets.ts` extracts selectors, labels, selector kind, selector score, and capture/page/viewport rects.
- `apps/server/src/routes/sessions.ts` supports create/list/get session, captures, browse actions, navigation, and image/DOM target read APIs.
- `apps/server/src/routes/annotations.ts` supports annotation create/list/patch/delete and coordinate conversion.
- `apps/server/src/routes/bugs.ts` supports bug create/list/detail/patch/relation/export and writes annotated screenshots/crops.
- `apps/server/src/routes/ai.ts` supports AI status, normalize job, job read/cancel, mock/openai-compatible provider, and trace JSON output.
- `apps/web/src/App.tsx` implements intake, workspace, tools, bug draft, bug list/detail, click recognition, export, settings, and shortcuts.
- `scripts/e2e-tongzhang-er.mjs` starts fixture/app servers, cleans local runtime data, runs browser actions, saves screenshots, validates export files.

## Playwright E2E Evidence

Latest run output:

- `.agent.local/evidence/tongzhang-er-final/e2e-result.json`
- `.agent.local/evidence/tongzhang-er-final/01-session-open.png`
- `.agent.local/evidence/tongzhang-er-final/02-bug-menu-element.png`
- `.agent.local/evidence/tongzhang-er-final/03-bug-cta-pin.png`
- `.agent.local/evidence/tongzhang-er-final/04-bug-chart-draw.png`
- `.agent.local/evidence/tongzhang-er-final/05-bug-dropdown-open.png`
- `.agent.local/evidence/tongzhang-er-final/06-bug-country-rect.png`
- `.agent.local/evidence/tongzhang-er-final/07-type-action.png`
- `.agent.local/evidence/tongzhang-er-final/08-fullpage-capture.png`
- `.agent.local/evidence/tongzhang-er-final/09-bug-list-before-export.png`
- `.agent.local/evidence/tongzhang-er-final/10-bugs-exported.png`

E2E result summary:

- target URL: `http://127.0.0.1:4888/inflation-2.html`
- bugs: 5
- annotation count: every bug has `1 annotations`
- exports: 5 export directories, each has `bug.md`, `bug.json`, annotated screenshot, and crop
- capabilities verified: domainAccess, browseClick, scroll, type, pin, rect, freehand, elementPick, aiNormalize, bugListDetail, fullPageCapture, exportEvidence

## Export Evidence

Runtime export location is ignored but verified locally:

- `.markit/exports/<bug-id>/bug.md`
- `.markit/exports/<bug-id>/bug.json`
- `.markit/exports/<bug-id>/captures/<capture-id>/screenshot.annotated.png`
- `.markit/exports/<bug-id>/captures/<capture-id>/crops/*.png`
- `.markit/exports/<bug-id>/captures/<capture-id>/metadata.json`
- `.markit/exports/<bug-id>/captures/<capture-id>/dom-targets.json`

## Review Hub Evidence

- request root: `.mission/review-dispatch/opencode/20260615T120124Z-markit-full-function-delivery-review/`
- aggregate: `.mission/review-dispatch/opencode/20260615T120124Z-markit-full-function-delivery-review/aggregate/aggregate.md`
- reviewers: qwen3.7-max, mimo-v2.5, MiniMax-M3
- result: 3/3 complete, 0 incomplete, 0 failures, 0 blockers

## Skipped Or Failed Checks

- Browser plugin `iab` was unavailable earlier in the iteration; final rendered/browser validation used real local Playwright instead.
- Real MMF/LDAP model channel was not required for AI normalizer because `MARKIT_AI_PROVIDER=mock` verified the app workflow and Review Hub used MMF reviewer models.

## Decision

PASS for full local Markit v1 delivery.

## Rendered DOM Evidence

The final rendered acceptance is covered by true Playwright E2E against `http://127.0.0.1:5173/`. It verifies the app can create a real session from the fixture domain, display screenshots, operate canvas tools, save bugs, render bug list/detail, and export evidence. Earlier bootstrap rendered DOM smoke also verified `Markit`, `Capture UI bugs from any URL`, `url-input`, `viewport-select`, `health-badge`, and zero forbidden OpenDesign/chat/project text.

## Screenshot Evidence

Screenshots are stored under `.agent.local/evidence/tongzhang-er-final/` and include session open, each annotation mode, type action, full-page capture, bug list before export, and bug list after export.
