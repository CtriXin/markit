# Source Priority And Conflicts

status: PASS

## Priority Order

1. User correction: implement the requirement, not only the plan doc.
2. `SRC-001 docs/implementation-plan.md`.
3. Repo/global workflow rules.

## Conflict Matrix

| Conflict | Decision |
|---|---|
| document-only vs implementation | implementation wins |
| full V1 in one patch vs x.y.z | x.y.z wins; bootstrap first |
| public-site baseline vs local tool | local/internal baseline wins |

## Decision

No unresolved conflicts.
