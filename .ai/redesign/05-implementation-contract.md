# OpenDesign Restyle Implementation Contract

## Scope

- 更新 Markit web app shell、workspace、评论/标注/bug panel、bug inbox 的视觉与中文文案。
- 保留现有 server/runtime/API/Playwright 功能，不重写后端。
- E2E 仍必须真实驱动 URL、点击、滚动、输入、标注、AI normalize、证据导出。

## Non-negotiables

- 使用 OpenDesign 截图底座：深色 chrome、左侧评论列表、紧凑工具栏、浅色 preview canvas、蓝色 selection/annotation。
- 页面可见普通文案中文化；URL、AI、Bug、DOM、selector、CTA、dropdown、CPI 等 technical terms 可保留 English。
- 不回退 warm paper、beige dashboard、purple gradient 或通用后台模板。
- Playwright 截图必须能复现 5 个“通胀二”Bug，并导出完整 evidence。

## Acceptance

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm probe:pixels`
- `pnpm e2e:tongzhang-er`
- Review Hub post-review request: `.review-hub/requests/20260615-markit-opendesign/`

## 2026-06-15 双端模拟补充

- Session workspace 默认创建两个真实 Playwright session：PC `1440x900` 与 Mobile 选择项。
- Stage 默认同时展示 PC + Mobile 两个 frame；默认 `Fit` 让两端完整进入画布区域，支持手动放大/缩小。
- 左侧评论/快照 rail 与右侧检查器都必须支持收起/展开。
- 顶部地址栏必须可输入真实 URL，支持“当前打开”和“双端打开”；不通过嵌入 Chrome 实现。

## 2026-06-15 默认单端修订

- Session workspace 默认只创建当前选择视口对应的一个真实 Playwright session；Home 默认 PC `1440x900`。
- PC/Mobile 是设备切换；如果目标端尚未创建，会用当前真实 URL 创建对应 session。
- 双端模拟由 `preview-dual` 显式开启，开启后才创建缺失端并显示 PC + Mobile。
- 地址栏在单端模式只打开当前端；双端模式才显示“同步双端”。
- 标注工具新增 `区块`，用于选择 section/article/card 级目标；`圈画` 保留真实 freehand path。
