# OpenDesign Restyle Handoff Packet

## User Correction

用户拒绝之前的 warm/paper 自由发挥，要求直接使用 OpenDesign 底座，并且页面全中文。

## Implemented Direction

- App shell 改为 OpenDesign-like dark chrome。
- 左侧改为“评论”线程形态，显示 selector-like 标题、中文 Bug 摘要、时间与 checkbox。
- 中央 stage 使用紧凑文件/工具栏、浅色 preview canvas、蓝色 selector/annotation。
- 右侧保留完整 Bug draft、点击识别、标注、截图信息，保证功能完整。
- Home/Bug/Settings/状态/按钮/表单全部中文化；technical terms 保留。

## Evidence

- E2E result: `.agent.local/evidence/tongzhang-er-final/e2e-result.json`
- Workspace screenshot: `.agent.local/evidence/tongzhang-er-final/01-session-open.png`
- Dropdown/selector screenshot: `.agent.local/evidence/tongzhang-er-final/05-bug-dropdown-open.png`
- Rect annotation screenshot: `.agent.local/evidence/tongzhang-er-final/06-bug-country-rect.png`
- Exported bug list screenshot: `.agent.local/evidence/tongzhang-er-final/10-bugs-exported.png`

## Residual Risks

- 右侧仍是功能完整的 Bug inspector，而不是完全照搬截图中的单个 floating popover；这是为保留 title/actual/expected/severity/export 功能做的产品取舍。
- 当前 Review Hub worker 正在/已执行 post-review；最终 aggregate 见 request root。
