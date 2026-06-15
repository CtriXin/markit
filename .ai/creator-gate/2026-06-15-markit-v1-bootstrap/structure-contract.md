# Structure Contract

## Current Scope Routes

- Web `/`: Markit shell, URL input placeholder, default viewport selector placeholder, recent sessions placeholder, server health badge.
- Server `GET /api/health`: returns status, app name, version, time.

## Workspace

- `apps/web`
- `apps/server`
- `packages/contracts`
- `packages/annotation-core`
- `packages/ai-normalizer`
- `packages/issue-sinks`
- `fixtures/test-site`

## Non-goals This Slice

- No screenshot API beyond pixel probe.
- No annotation CRUD.
- No SQLite schema implementation.
- No AI calls.
