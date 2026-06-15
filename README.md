# Markit

Markit 是一个本地 URL 标注、bug capture、bug list/detail 和 evidence export 工具。核心流程：输入 URL -> Playwright 打开真实页面 -> click/scroll/type 到目标状态 -> 截图 -> pin/rect/freehand/element/section 标注 -> 保存 bug -> 导出 Markdown/JSON/annotated screenshot/crop/DOM targets。

## Bootstrap

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm probe:pixels
pnpm e2e:tongzhang-er
pnpm e2e:public-url
pnpm e2e:macromoss
pnpm dev
```

`pnpm dev` 会启动：

- API: `http://127.0.0.1:4317`
- Web: `http://127.0.0.1:5173`
- 本地数据：`.markit/`

## Current scope

已实现 v1 本地完整闭环：

- URL intake + recent sessions；支持 public URL 和 localhost。
- 默认单端真实 Playwright session；可切换 PC/Mobile，也可打开双端对照。
- Mobile/desktop viewport presets，Playwright screenshot 使用 CSS pixel scale。
- Browse actions：click、scroll、type、key、reload、back、forward，并自动 recapture。
- Capture actions：viewport capture 和 full-page capture。
- Annotation tools：pin、rect（drag 或 two-click）、ellipse 截图式圈选、freehand 自由画、element pick、section/card 区块选择；右侧展示 selector/label/score。
- Bug workflow：少填字段快速保存、Bug 类型 chips、保存 bug、bug list、bug detail、status/severity/title/actual/expected 编辑、需求/Figma 引用、annotation relation。
- Evidence export：每个 bug 生成 `bug.md`、`bug.json`、annotated screenshot、crop、metadata、DOM targets。
- AI normalizer：默认 off；`MARKIT_AI_PROVIDER=mock` 可本地验证；也预留 `openai-compatible` provider。
- 通胀二 Playwright E2E：`pnpm e2e:tongzhang-er` 会启动 fixture/app，模拟 5 个飞书 bug，生成截图和解析到 `.agent.local/evidence/tongzhang-er-final/`。
- 真实公网 URL smoke：`pnpm e2e:public-url` 默认访问 `https://example.com/`，验证默认单端与可选双端真实 Playwright 渲染，证据输出到 `.agent.local/evidence/public-url-smoke/`。
- Macromoss 真实站点 smoke：`pnpm e2e:macromoss` 访问 `https://macromoss.com/`，验证真实点击跳转、圈画、section 选择与可选双端，证据输出到 `.agent.local/evidence/macromoss-real/`。

## AI normalizer

```bash
MARKIT_AI_PROVIDER=mock pnpm dev
```

OpenAI-compatible provider 预留环境变量：

```bash
MARKIT_AI_PROVIDER=openai-compatible
MARKIT_MODEL_BASE_URL=https://example.com/v1
MARKIT_MODEL_API_KEY=...
MARKIT_MODEL_ID=...
```

## Evidence

最新本地验收会输出：

- `.agent.local/evidence/tongzhang-er-final/e2e-result.json`
- `.agent.local/evidence/tongzhang-er-final/*.png`
- `.agent.local/evidence/public-url-smoke/result.json`
- `.agent.local/evidence/public-url-smoke/*.png`
- `.agent.local/evidence/macromoss-real/result.json`
- `.agent.local/evidence/macromoss-real/*.png`
- `.markit/exports/<bug-id>/bug.md`
- `.markit/exports/<bug-id>/bug.json`
- `.markit/exports/<bug-id>/captures/<capture-id>/screenshot.annotated.png`
- `.markit/exports/<bug-id>/captures/<capture-id>/crops/*.png`
