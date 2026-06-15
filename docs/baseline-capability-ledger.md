# Baseline Capability Ledger

- Project: Markit
- Repo: `/Users/xin/auto-skills/CtriXin-repo/markit`
- Service: local Markit web + API
- Primary domain: not-applicable, local-only tool
- Serving shape: static-spa
- Site profile: internal-tool
- Baseline mode: default-on
- Created at: 2026-06-15
- Source: `docs/implementation-plan.md`

Status values: `enabled`, `partial`, `not-applicable`, `opt-out`.

## L0 Universal

| Capability | Status | Evidence / Implementation | Reason if not enabled | Owner / Next |
|---|---|---|---|---|
| project-identity | enabled | `package.json`, `README.md`, app title `Markit` |  | codex |
| baseline-ledger | enabled | `docs/baseline-capability-ledger.md` |  | codex |
| env-schema | enabled | `.env.example` |  | codex |
| config-boundary | enabled | `config/site.config.json`, `config/domain.config.json`, `apps/server/src/config.ts`, `apps/web/vite.config.ts` |  | codex |
| domain-config | not-applicable | `config/domain.config.json`, local-only `127.0.0.1` API and Vite dev host | No production domain in V1 | codex |
| seo-tdk | not-applicable | `apps/web/index.html` basic app title | Internal local tool, not SEO page | codex |
| legal-footer-ia | not-applicable | no public traffic | Internal local tool, no legal footer required in bootstrap | codex |
| health-version | enabled | `GET /api/health`, web health badge |  | codex |
| not-found | partial | Vite fallback during bootstrap | Dedicated 404 is not needed until route expansion | future x.y.z |
| cache-assets | partial | Vite default cache behavior | Production cache policy not applicable until packaging/deploy | future x.y.z |
| local-validation | enabled | `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm probe:pixels` |  | codex |
| secret-boundary | enabled | `.env.example`, `.gitignore` excludes `.env*` |  | codex |

## L1 Public Site

| Capability | Status | Evidence / Implementation | Reason if not enabled | Owner / Next |
|---|---|---|---|---|
| analytics-entry | not-applicable | none | Local internal tool, no public analytics in V1 | codex |
| pageview-entry | not-applicable | none | Local internal tool | codex |
| stats-pv-id | not-applicable | none | Local internal tool | codex |
| stats-event-bridge | not-applicable | none | Not a WebView public site | codex |
| report-adapter | not-applicable | none | No company report endpoint in V1 | codex |
| source-record | enabled | `.ai/creator-gate/2026-06-15-markit-v1-bootstrap/source-inventory.md` |  | codex |
| sitemap-robots | not-applicable | none | No public crawl surface | codex |

## L2 Ads Site

| Capability | Status | Evidence / Implementation | Reason if not enabled | Owner / Next |
|---|---|---|---|---|
| ads-source-readback | not-applicable | none | Markit is not an ads site | codex |
| ad-runtime | not-applicable | none | Markit is not an ads site | codex |
| ad-domain-config | not-applicable | none | Markit is not an ads site | codex |
| ads-txt | not-applicable | none | Markit is not an ads site | codex |
| adscore | not-applicable | none | Markit is not an ads site | codex |
| ad-lazy-load | not-applicable | none | Markit is not an ads site | codex |
| unfilled-collapse | not-applicable | none | Markit is not an ads site | codex |
| ad-debug-mode | not-applicable | none | Markit is not an ads site | codex |
| ad-telemetry-v2 | not-applicable | none | Markit is not an ads site | codex |
| legacy-ad-bridge | not-applicable | none | Markit is not an ads site | codex |

## L3 SSR Service

| Capability | Status | Evidence / Implementation | Reason if not enabled | Owner / Next |
|---|---|---|---|---|
| runtime-guard | not-applicable | none | V1 bootstrap is local Express API, not production SSR service | codex |
| release-watch | not-applicable | none | No production release in V1 | codex |
| rolling-logs | not-applicable | none | No production service logs in V1 | codex |
| server-error-log | partial | Express error envelope in later API work | Full error logging belongs to API stability slice | future x.y.z |
| asset-404-log | not-applicable | none | Static assets served by Vite in bootstrap | codex |
| api-error-log | partial | Basic health route only | Full API error normalization belongs to later routes | future x.y.z |
| ssr-html-no-store | not-applicable | none | Not SSR | codex |
| missing-asset-404 | not-applicable | none | Not SSR | codex |

## COS Overlay

| Capability | Status | Evidence / Implementation | Reason if not enabled | Owner / Next |
|---|---|---|---|---|
| static-health | not-applicable | none | No COS/static deployment | codex |
| version-json | not-applicable | none | No COS/static deployment | codex |
| asset-manifest | not-applicable | none | No COS/static deployment | codex |
| static-404 | not-applicable | none | No COS/static deployment | codex |
| cdn-decode-smoke | not-applicable | none | No COS/static deployment | codex |

## Gaps

- `not-found` and cache policy remain `partial` until route expansion/packaging.
- server/API logging remains `partial` until API stability slices.
- No secrets committed; `.env.example` contains names only.
