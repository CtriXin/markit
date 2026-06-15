# OpenDesign Restyle QA Checklist

- [x] `pnpm typecheck` — pass, 2026-06-15 21:19 SGT
- [x] `pnpm test` — pass after updating web copy guard, 2026-06-15 21:21 SGT
- [x] `pnpm build` — pass, 2026-06-15 21:21 SGT
- [x] `pnpm probe:pixels` — pass, desktop/mobile pixel probe
- [x] rendered Playwright screenshot of session workspace — `.agent.local/evidence/tongzhang-er-final/01-session-open.png`
- [x] no old warm-paper visual leakage in workspace — dark OpenDesign-like chrome in screenshots
- [x] blue annotation/selection marks visible on canvas — `05-bug-dropdown-open.png`, `06-bug-country-rect.png`
- [x] dark comment/sidebar/editor chrome visible — `01-session-open.png`, `05-bug-dropdown-open.png`
- [x] `pnpm e2e:tongzhang-er` — pass, 5 bugs + exports, 2026-06-15 21:14 SGT
- [x] Review Hub request created — `.review-hub/requests/20260615-markit-opendesign/`

- [x] type action 硬断言 — `e2e-result.json` includes `capabilities.typeValueVerified: true`，`07-type-action.png` 可见目标 input 值。
- [x] fixture 可见内容中文化 — `01-session-open.png` / `07-type-action.png` 已显示中文目标页内容。
- [x] final Review Hub PASS — `.review-hub/requests/20260615-markit-opendesign/aggregate/aggregate.md`。

## 双端模拟交互补充

- [x] 默认 PC + Mobile 双端预览可见 — `01-session-open.png` 同时显示 `device-pc` 和 `device-mobile`。
- [x] 缩放控制可用 — `zoom-in` / `zoom-out` / `zoom-fit` 有 Playwright 断言和截图 `01b-dual-zoom.png`。
- [x] 左右工具栏可收起并恢复 — `toggle-left-rail` / `toggle-right-panel` 有 Playwright 断言和截图 `01c-collapsed-rails.png`。
- [x] 顶部真实地址栏可输入 — `session-address` + `navigate-all` 双端重新打开 URL，截图 `01d-address-navigation.png`。
- [x] 原有通胀二标注、点击识别、AI normalize、证据导出回归仍通过 — `pnpm e2e:tongzhang-er`，2026-06-15 22:41 SGT。
- [x] 真实公网地址 smoke — `pnpm e2e:public-url` 访问 `https://example.com/`，截图 `.agent.local/evidence/public-url-smoke/01-public-url-dual.png`，2026-06-15 22:40 SGT。

- [x] Review Hub dispatch 复验 — `.mission/review-dispatch/opencode/20260615T144259Z-markit-url/aggregate/aggregate.md`，3/3 complete，0 blockers，2026-06-15 22:53 SGT。

## 默认单端 + Macromoss 真实访问补充

- [x] 默认单端，不再默认双端 — `pnpm e2e:public-url` 断言 `hasPc=false`、`hasMobile=true`；`pnpm e2e:macromoss` 断言 `hasPc=true`、`hasMobile=false`。
- [x] 双端可选 — `preview-dual` 后同时出现 PC/Mobile，截图 `.agent.local/evidence/macromoss-real/05-macromoss-dual-optional.png`。
- [x] 真实点击跳转 — `pnpm e2e:macromoss` 通过 Markit browse click 从 `https://macromoss.com/` 跳到 `https://macromoss.com/indicators`，截图 `02-macromoss-after-real-click.png`。
- [x] 圈画 — `tool-freehand` 在真实页面区域生成 freehand annotation，截图 `03-macromoss-circle-freehand.png`。
- [x] section/card 区块选择 — `tool-section` 命中真实 `section/article` target，截图 `04-macromoss-section-pick.png`。
- [x] 工具栏布局复验 — 预览/设备/工具/截图/输入/缩放分组在同一条 OpenDesign-like toolstrip 中，不再混乱换行。
- [x] Review Hub dispatch 复审 — `.mission/review-dispatch/opencode/20260615T152054Z-markit-macromoss/aggregate/aggregate.md`，3/3 complete，0 incomplete，三个 reviewer 全部 PASS。
