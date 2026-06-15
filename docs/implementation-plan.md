# Markit 实施计划（小步迭代版 v4）

## 1. 目标

Markit 是一个独立的本地 URL 标注与 bug capture 工具。

核心流程：

```text
输入 URL -> 打开页面 -> 操作页面到目标状态 -> 截图 -> 标注/评论 -> 保存 bug -> 导出 evidence
```

第一版必须本地完整可用，不依赖 OpenDesign project/run/artifact/chat，也不强依赖飞书。

## 2. 产品边界

### 做

- 读取任意 URL，包括 public URL 和 localhost。
- 支持 desktop/mobile viewport。
- 支持页面 click、scroll、type、reload 后重新截图。
- 支持 screenshot canvas 标注。
- 支持 pin、rect、freehand、element pick。
- 支持 comment、actual、expected、severity、status。
- 支持本地 bug list/detail。
- 支持 AI requirement normalizer：把标注后的口语描述转成标准 bug/需求草稿，必要时反问标注者。
- 支持导出 Markdown、JSON、原图、标注图、crop、DOM targets。
- 预留 Feishu sink adapter，但不在第一轮强做。

### 不做

- 不做 AI 自动修复。
- 不让 AI 自动提交 bug；AI 输出必须可编辑、可拒绝、可追问。
- 不接 OpenDesign chat。
- 不做账号/多用户/权限。
- 不做复杂 dashboard。
- 不做飞书字段 mapping UI。
- 不把 OpenDesign 整个 FileViewer 搬过来。

## 3. 视觉方向

以 OpenDesign 当前 preview/comment viewer 为基础做减法。

要求：

- 工具感、干净、紧凑。
- 不做 AI 风 hero。
- 不做后台系统表格感。
- 不做紫色渐变、玻璃拟态、大插画。
- 保留 OpenDesign 的 toolbar、viewer canvas、right comment panel 气质。

基础 token：

```css
--mk-bg: #f4f1ea;
--mk-panel: #fbfaf7;
--mk-panel-strong: #ffffff;
--mk-border: rgba(31, 28, 24, 0.12);
--mk-text: #211f1b;
--mk-muted: #6f6a61;
--mk-accent: #0f766e;
--mk-danger: #e5484d;
--mk-select: #1677ff;
--mk-note: #f59e0b;
--mk-resolved: #16a34a;
--mk-shadow: 0 18px 50px rgba(30, 25, 18, 0.10);
--mk-radius: 14px;
```

标注语义：

- 红色：bug / critical mark。
- 蓝色：selected element。
- 黄色：note / ambiguous mark。
- 绿色：resolved。

## 4. 页面结构

```text
/                    URL intake + recent sessions
/session/:sessionId   标注工作台
/bugs                 本地 bug inbox
/bugs/:bugId          bug detail / evidence
/settings             本地设置
```

## 5. 首页

首页只做入口，不做营销页。

```text
Markit
Capture UI bugs from any URL

[ URL input                                            ]
[ viewport preset ] [ Open session ]

Recent sessions
- macromoss.com        mobile 390x844      12 bugs
- localhost:3000       desktop 1440x900    3 bugs
```

行为：

- URL 输入 Enter 创建 session。
- 默认 viewport 读取 settings。
- 最近 session 可继续打开。

## 6. 标注工作台

主页面三栏结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top Bar: URL / viewport / reload / capture / export / settings│
├──────────────┬─────────────────────────────────┬─────────────┤
│ Left Rail    │ Canvas                          │ Right Panel │
│ Captures     │ screenshot + annotation overlay │ Bug Draft   │
│ Session bugs │ browse/annotate modes           │ fields      │
└──────────────┴─────────────────────────────────┴─────────────┘
```

建议尺寸：

- Left rail: 260px。
- Right panel: 360px。
- Top bar: 56px。
- Canvas 自适应。

### Top Bar

包含：

- URL display/input。
- Back / Forward / Reload。
- Viewport selector。
- Capture viewport。
- Capture full page。
- Open in browser。
- Session status。

Viewport presets：

```text
Desktop 1440x900
Laptop 1366x768
Tablet 820x1180
Mobile 430x932
Mobile 390x844
Mobile 360x800
Custom
```

### Canvas

两种模式：

- Browse：click/scroll/type 作用到 Playwright 页面，并按 action policy 生成新 capture。
- Annotate：在当前 capture screenshot 上标注，不操作真实页面。

Browse 操作只对当前 viewport 生效。即使当前显示的是 full-page capture，进入 Browse 后也必须先切到该 capture 对应的 viewport window：click/type/key 使用 viewport 坐标，scroll 改变 viewport window，再生成新的 viewport capture。第一版不支持在 full-page image 任意远端位置直接点击；full-page 只用于审阅和标注。

工具栏：

```text
[Browse] [Pointer] [Pin] [Rect] [Draw] [Element] [Crop] | zoom
```

快捷键：

```text
B Browse
V Pointer
P Pin
R Rect
D Draw
E Element
C Capture
Esc Cancel
Cmd/Ctrl+S Save
```

### Left Rail

上半：captures。

```text
Captures
- 16:42 mobile 390 /countries/germany
- 16:40 mobile 390 /
- 16:35 desktop 1440 /
```

下半：session bugs。

```text
Bugs
- P0 菜单按钮看不到
- P1 卡片间距太小
- P2 标题换行
```

点击 capture：切换 canvas。
点击 bug：打开对应 capture + 高亮标注。

### Right Bug Panel

固定结构，避免“随手评论”变模糊 bug。

字段：

```text
Title
Severity: P0 / P1 / P2 / P3
Status: draft / open / resolved / wontfix
Actual
Expected
Annotations
Source URL
Final URL
Viewport
Capture time
```

按钮：

```text
Save bug
Export evidence
Copy markdown
```

保存约束：

- comment 可以短。
- bug 必须有 title、actual、expected、severity。
- 缺字段时 Save disabled，并显示缺口。

Annotation 与 active draft 规则：

- 右侧没有 active bug draft 时，新建 annotation 会自动创建一个 draft bug，但不自动填 actual/expected。
- 右侧已有 active draft/open bug 时，新 annotation 默认挂到该 bug；用户可手动移除 relation。
- Bug 可以零 annotation 保存，但 UI 需要显示“无标注 evidence”提示；export 仍生成 `bug.md` / `bug.json`。
- 删除 annotation 时必须同时删除 `bug_annotations` relation；不删除 bug。
- 从 bug 移除 annotation 只删 relation，不删 annotation 原始记录。

AI 辅助区：

```text
Comment / 口语描述
[用户输入：这里按钮太靠下，感觉和 Figma 不一致]
[Normalize]

Requirement Draft
- Title
- Actual
- Expected
- Repro steps
- Acceptance criteria

[Apply to bug] [Ask again] [Discard]
```

- Normalize 只读取当前 active bug、关联 annotations、capture metadata、DOM target 摘要和用户输入。
- 默认不发送整张 screenshot；如后续支持 vision，只发送用户确认过的 crop。
- 如果 AI 不确定，显示 1-3 个 clarification questions，不直接生成完整 bug。
- Normalize 是异步 job；用户可以继续标注/编辑，完成后右侧 panel 出现结果。
- Clarification 默认一次性成组提出，用户可以逐条回答，回答完再点 `Update draft` 触发下一次整理。
- Apply 前所有字段可编辑；Apply 后仍走原来的 Save 约束。

## 7. Bug Inbox

`/bugs` 是卡片 list，不做重后台表格。

```text
Bugs
Filter: All / Draft / Open / Resolved
Severity: P0 P1 P2 P3

[P0] mobile 首页菜单按钮看不到
macromoss.com / 390x844 / 2 annotations

[P1] /indicators 卡片百分比太小
macromoss.com / desktop / 1 annotation
```

## 8. Bug Detail

展示 evidence，不只展示表单。

```text
Title / severity / status
Annotated screenshot
Crops
Actual / Expected
URL / viewport / timestamp
Annotations grouped by capture
Export actions
```

支持：

- 编辑字段。
- resolve / reopen。
- copy markdown。
- export evidence。
- back to session。

## 9. Settings

只放必要设置。

```text
Storage
- Data directory: .markit/
- Open data folder
- Export directory

Browser
- Default viewport
- Navigation timeout
- Capture default: viewport/full-page
- Full-page max height
- Device scale factor
- Auto recapture after browse action: on/off

Issue sinks
- Local evidence folder: enabled
- Markdown clipboard: enabled
- Feishu Base: later

AI Normalizer
- Provider: off / mock / openai-compatible / local MMS-MMF
- Default model
- Clarification mode: strict by default
- Ask clarification threshold
- Send screenshot crop to model: off by default
- Company auth mode: none in V1; LDAP later

Advanced
- Clear stale sessions
- Delete browser cache
- Reset settings
```

## 10. 技术结构

使用独立 workspace：

```text
apps/web       React + Vite
apps/server    Express + Playwright + SQLite
packages/contracts
packages/annotation-core
packages/ai-normalizer
packages/issue-sinks
```

理由：

- Markit 是本地工具，不需要 Next。
- Server 需要管理 Playwright browser/page、SQLite、filesystem。
- Vite + Express 足够轻。
- 后续可包装 Electron/Tauri。

包职责边界：

- `apps/web`：只负责 UI state、canvas 交互、API client；不直接读写 `.markit/`。
- `apps/server`：负责 Playwright runtime、SQLite、filesystem、AI provider 调用、export。
- `packages/contracts`：只放 DTO、schema、error code、example payload；不得依赖 React、Express、Playwright、SQLite、filesystem。
- `packages/annotation-core`：只放坐标变换、hit-test、geometry normalize、annotated image composition 的纯函数。
- `packages/ai-normalizer`：只放 prompt builder、structured schema、provider-neutral response parser；不持有 key，不访问 DB。
- `packages/issue-sinks`：只放 `LocalEvidenceSink` 和未来 `FeishuSink` adapter interface；V1 只实现 local/clipboard。

根脚本合同：

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm --filter @markit/server dev\" \"pnpm --filter @markit/web dev\"",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "probe:pixels": "pnpm --filter @markit/server probe:pixels"
  }
}
```

`pnpm dev` 是同事使用入口；package-scoped scripts 是实现和 CI 入口。

## 11. 数据目录

默认写入：

```text
.markit/
  app.sqlite
  captures/
    cap_xxx/
      screenshot.png
      screenshot.annotated.png
      dom-targets.json
      metadata.json
  ai-runs/
    ai_xxx.json
  exports/
    bug_xxx/
      bug.md
      bug.json
      captures/
        cap_xxx/
          screenshot.png
          screenshot.annotated.png
          dom-targets.json
          metadata.json
          crops/
            ann_xxx.png
```

`.markit/` 必须 gitignore。

## 12. 核心 contract

### 基础类型

所有坐标默认使用 CSS pixel，不使用 device pixel。Playwright screenshot 必须使用 `scale: 'css'`，确保 `1 screenshot image pixel == 1 CSS pixel`。

```ts
type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type Viewport = {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile?: boolean;
};
```

### Session

```ts
type MarkitSession = {
  id: string;
  sourceUrl: string;
  currentUrl: string;
  title: string;
  viewport: Viewport;
  sessionVersion: number;
  runtimeStatus: 'active' | 'inactive' | 'expired' | 'archived' | 'error';
  createdAt: string;
  updatedAt: string;
};
```

`sessionVersion` 每次 navigation/action/viewport change 后递增。前端提交 action 时带 `baseSessionVersion`，server 用它识别 stale action。

### Capture

```ts
type MarkitCapture = {
  id: string;
  sessionId: string;
  sessionVersion: number;
  url: string;
  finalUrl: string;
  title: string;
  viewport: Viewport;
  scroll: { x: number; y: number };
  mode: 'viewport' | 'fullPage';
  screenshotPath: string;
  domTargetsPath: string;
  imageSize: { width: number; height: number };
  createdAt: string;
};
```

`mode='viewport'` 时 image 原点是当前 viewport 左上角。`mode='fullPage'` 时 image 原点是 page 左上角。

### DomTarget

```ts
type DomTarget = {
  id: string;
  selector: string;
  selectorKind: 'testid' | 'aria' | 'id' | 'css-path' | 'text-fallback';
  selectorScore: number;
  tagName: string;
  role?: string;
  label: string;
  text: string;
  htmlHint: string;
  pageRect: Rect;
  viewportRect: Rect;
  captureRect: Rect;
  visible: boolean;
};
```

采集规则：

- 在 capture 后通过 `page.evaluate` 采集。
- 只采集 visible target：有尺寸、未 hidden、未 display none、未 pointer-events none。
- 优先目标：`a/button/input/textarea/select/label/img/video/canvas/h1-h6/p/li/td/th/section/article/main/aside/nav`。
- 其次采集有 `role`、`aria-label`、`title` 的元素。
- 最后采集有短文本且不是纯 wrapper 的元素。
- `captureRect` 由 `pageRect` 和 capture origin 计算；element pick 使用 `captureRect` 覆盖到 screenshot。

`selectorScore` 必须 deterministic，范围 0..100：

```text
base:
  testid        100
  aria           90
  id             80
  css-path       55
  text-fallback  35

modifiers:
  interactive tag                    +10
  has role / aria-label / title       +8
  selector unique in document         +5
  css-path depth > 6                  -8
  css-path depth > 10                -16
  text fallback length > 80          -10
  selector failed re-query           -30
```

最终 `selectorScore = clamp(base + modifiers, 0, 100)`。同一个 DOM 在同一次 capture 中必须算出同分，不能依赖遍历顺序。

Element pick 命中算法：

1. 前端把 display point 转成 capture point。
2. 在当前 capture 的 `DomTarget[]` 中筛选 `captureRect` 包含该点的目标。
3. 优先选择面积最小的目标；面积相同按 `selectorScore` 高者优先。
4. 如果没有命中目标，降级为 pin annotation。
5. Hover 时同样使用该算法，只显示一个最高优先目标，避免重叠元素同时高亮。

### Annotation

```ts
type MarkitAnnotation = {
  id: string;
  captureId: string;
  kind: 'pin' | 'rect' | 'freehand' | 'element';
  geometry: AnnotationGeometry;
  target?: DomTarget;
  note: string;
  colorRole: 'bug' | 'note' | 'selected' | 'resolved';
  createdAt: string;
  updatedAt: string;
};

type AnnotationGeometry = {
  pageRect: Rect;
  captureRect: Rect;
  viewportRect: Rect;
  paths?: Point[][];
};
```

`pageRect` 是唯一真相坐标。`captureRect`、`viewportRect` 是派生结果，也持久化用于 export/debug。更新 annotation 时必须由 `pageRect + capture metadata` 重新计算派生坐标。

### Bug

```ts
type MarkitBug = {
  id: string;
  sessionId: string;
  title: string;
  actual: string;
  expected: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'draft' | 'open' | 'resolved' | 'wontfix';
  sourceUrl: string;
  finalUrl: string;
  primaryCaptureId?: string;
  tags: string[];
  exportPath?: string;
  createdAt: string;
  updatedAt: string;
};

type MarkitBugAnnotation = {
  bugId: string;
  annotationId: string;
  sortOrder: number;
};
```

归属关系只由 `bug_annotations` join table 表达。`annotations` 不保存 `bugId`，`bugs` 不保存 `annotationIds[]`。API/contract 字段名使用 `sortOrder`，SQLite 列名使用 `sort_order`。API 可以展开返回，但数据库不双向持有，避免失同步。

### AI Requirement Normalizer

AI 只生成可编辑草稿，不直接保存 bug，不直接提交飞书。

```ts
type BugRequirementDraft = {
  title: string;
  problemType: 'visual' | 'layout' | 'interaction' | 'copy' | 'data' | 'performance' | 'other';
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  actual: string;
  expected: string;
  affectedArea: string;
  reproSteps: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  confidence: number; // 0..1
  fieldConfidence: Record<'title' | 'problemType' | 'severity' | 'actual' | 'expected' | 'affectedArea' | 'reproSteps' | 'acceptanceCriteria', number>;
};

type BugClarificationRequest = {
  kind: 'clarification_required';
  questions: Array<{
    id: string;
    question: string;
    reason: 'missing_actual' | 'missing_expected' | 'ambiguous_target' | 'severity_unclear' | 'scope_unclear';
    suggestions?: string[];
  }>;
  partialDraft: Partial<BugRequirementDraft>;
};
```

触发反问的条件：

- `confidence < settings.ai.clarificationThreshold`，strict 默认 0.98。
- 任一核心字段 `fieldConfidence < 0.98`。
- 缺 `actual`、`expected`、`affectedArea` 任一核心字段。
- annotation target 与用户描述冲突，例如点到按钮但描述在说卡片列表。
- severity 无法从描述和影响面推断。
- `expected` 只是模型基于常识推断、没有来自用户原文/设计规范/明确 DOM 证据支撑。

标准行为：

- AI 输出写入右侧 `Requirement Draft` 区块，用户确认后才覆盖 bug 表单。
- 用户回答 clarification 后，前端再次调用 normalize，并带上 `partialDraft + answers`。
- 所有 AI 输出都保留 `sourceText` 和 `modelTraceId`，方便后续排查误解来源。
- 字段级规则是“没有证据就反问”：AI 可以给 suggestion，但 suggestion 不能自动变成最终字段。

### SQLite schema / migrations appendix

V1 使用 SQLite，migration 必须 transaction 内执行。`schema_migrations` 是迁移真相源，`PRAGMA user_version` 只作为快速诊断。

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  current_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  viewport_json TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  runtime_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  viewport_json TEXT NOT NULL,
  scroll_x REAL NOT NULL,
  scroll_y REAL NOT NULL,
  mode TEXT NOT NULL,
  screenshot_path TEXT NOT NULL,
  dom_targets_path TEXT NOT NULL,
  image_width REAL NOT NULL,
  image_height REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  geometry_json TEXT NOT NULL,
  target_json TEXT,
  note TEXT NOT NULL DEFAULT '',
  color_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  actual TEXT NOT NULL DEFAULT '',
  expected TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  primary_capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  export_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bug_annotations (
  bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (bug_id, annotation_id)
);

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bug_id TEXT REFERENCES bugs(id) ON DELETE SET NULL,
  capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  trace_path TEXT NOT NULL,
  latency_ms INTEGER,
  schema_valid INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

索引：

```sql
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_captures_session_created ON captures(session_id, created_at DESC);
CREATE INDEX idx_annotations_capture_created ON annotations(capture_id, created_at ASC);
CREATE INDEX idx_bugs_status_updated ON bugs(status, updated_at DESC);
CREATE INDEX idx_bugs_session_updated ON bugs(session_id, updated_at DESC);
CREATE INDEX idx_bug_annotations_bug_order ON bug_annotations(bug_id, sort_order ASC);
CREATE INDEX idx_ai_jobs_session_updated ON ai_jobs(session_id, updated_at DESC);
```

Migration 规则：

- `db/migrations.ts` 只允许 append migration，不修改已发布 migration。
- 每个 migration 必须包含 `up(db)` 和 `name`，版本号单调递增。
- 启动时先跑 migration，再启动 HTTP server。
- migration 失败时 server fail fast，不创建半可用 runtime。
- 删除 annotation 依赖 `bug_annotations ON DELETE CASCADE` 清理 relation。
- V1 的 `DELETE /api/sessions/:id` 只允许做逻辑 archive；禁止直接执行 `DELETE FROM sessions`，避免误触发 bug/capture 级联删除。

## 13. Browse action 契约

Browse mode 的动作统一走 `POST /api/sessions/:id/actions`。

### 请求

```ts
type MarkitActionRequest = {
  clientSeq: number;
  baseSessionVersion: number;
  baseCaptureId?: string;
  action:
    | { type: 'click'; point: Point }
    | { type: 'scroll'; delta: Point }
    | { type: 'type'; text: string }
    | { type: 'press'; key: string }
    | { type: 'reload' }
    | { type: 'goBack' }
    | { type: 'goForward' };
  capturePolicy: 'viewport' | 'fullPage' | 'none';
  waitAfterMs?: number;
};
```

`baseCaptureId` 是前端发起 action 时用户正在看的 capture。server 用它校验 action 坐标与 runtime viewport 是否同源：

- `baseCaptureId` 缺失时，server 使用 session 最新 viewport capture。
- `baseCaptureId` 指向 full-page capture 且 action 需要坐标时，server 返回 `action_failed`，message 指明 full-page 不能直接 Browse click。
- `baseCaptureId` 不是当前 session 最新可操作 viewport capture 时，server 可以执行 action，但必须返回 `staleBase=true`，前端刷新 capture rail。

坐标规则：

- `click.point` 使用当前 viewport CSS pixel，原点是 viewport 左上角。
- 前端从 canvas display 坐标换算到 `captureRect`，再用 capture metadata 转成 viewport point。
- 如果当前 canvas 是 full-page capture，Browse click 禁用，并提示“先 Capture viewport 或滚动到该区域”；Annotate 仍可在 full-page 上标注。
- `scroll.delta` 是 CSS pixel，server 用 `page.mouse.wheel(delta.x, delta.y)`。
- wheel 在前端 150ms debounce，避免每个滚轮 tick 都截图。

默认策略：

- click / scroll / type / press / reload 默认 `capturePolicy='viewport'`。
- `capturePolicy='none'` 只用于后续性能优化；第一版 UI 默认不用。
- `waitAfterMs` 默认 250ms，上限 3000ms；导航类 action 可由 server 等待 `networkidle` 或超时后 capture。
- Settings 的 auto recapture 关闭时，前端发送 `capturePolicy='none'`，并显示“Capture needed”状态。
- action 执行时前端进入 loading，禁用 annotate。
- action 成功且返回 capture 后，canvas 自动切到新 capture；旧 capture 留在 rail。
- action 失败时保留旧 capture，并显示错误，不写半成品 capture。

Type/focus 规则：

- `type` 只发送到 Playwright 当前 focused element。
- 如果没有 focused editable element，server 返回 `action_failed`，message 为 `No focused editable element`。
- 用户需要先用 Browse click 聚焦 input/textarea/contenteditable，再 type。
- `press` 可在无 focused editable element 时发送，用于 Escape、Tab、Enter 等页面级键。

### 响应

```ts
type MarkitActionResponse = {
  ok: true;
  clientSeq: number;
  session: MarkitSession;
  pageState: {
    url: string;
    finalUrl: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
  };
  capture?: MarkitCapture;
  staleBase?: boolean;
} | {
  ok: false;
  clientSeq: number;
  error: {
    code: 'stale_session' | 'navigation_failed' | 'action_failed' | 'capture_failed' | 'session_expired';
    message: string;
  };
};
```

`staleBase=true` 表示 action 执行成功，但 `baseSessionVersion` 已不是最新。前端必须刷新 session/capture rail，不能把旧 UI 状态当最新。

## 14. 坐标系统与变换规则

唯一真相：`pageRect`，单位 CSS pixel，原点是页面文档左上角。

### Capture origin

```ts
type CaptureOrigin = {
  mode: 'viewport' | 'fullPage';
  pageX: number;
  pageY: number;
};
```

- viewport capture: `origin = { pageX: scroll.x, pageY: scroll.y }`。
- fullPage capture: `origin = { pageX: 0, pageY: 0 }`。

### 变换

```text
captureRect.x = pageRect.x - origin.pageX
captureRect.y = pageRect.y - origin.pageY

viewportRect.x = pageRect.x - capture.scroll.x
viewportRect.y = pageRect.y - capture.scroll.y

displayX = captureRect.x * zoom + pan.x
displayY = captureRect.y * zoom + pan.y

captureX = (displayX - pan.x) / zoom
captureY = (displayY - pan.y) / zoom

pageX = captureX + origin.pageX
pageY = captureY + origin.pageY
```

### DPR 规则

- Playwright screenshot 必须使用 `scale: 'css'`。
- `deviceScaleFactor` 只做环境记录，不参与标注坐标乘除。
- 如果未来需要 `scale:'device'`，必须新增 `imageScale` 字段，不允许复用当前公式。

### Playwright pixel probe

`0.5.0` 必须先跑像素探针，验证坐标系统的基础假设。探针脚本：`apps/server/src/probes/playwright-css-pixel.ts`，命令：`pnpm probe:pixels`。

Fixture：

```html
<div id="probe-box" style="position:absolute;left:23px;top:17px;width:137px;height:91px;background:#ff0000"></div>
```

探针矩阵：

```text
viewport 320x240, deviceScaleFactor 1, scale css
viewport 320x240, deviceScaleFactor 2, scale css
viewport 390x844, deviceScaleFactor 3, scale css, isMobile true
```

通过条件：

- viewport screenshot PNG 尺寸必须等于 viewport CSS size。
- `#probe-box.getBoundingClientRect()` 返回 `23,17,137,91`，允许误差 `< 0.5px`。
- screenshot 中 `(23,17)` 到 `(159,107)` 区域能采样到 probe 色，边界外不能误判为 probe 色。
- fullPage screenshot 宽度等于 viewport CSS width，高度大于等于 document CSS height。
- 任一条件失败时不得进入 `2.x.z` capture runtime 或 `5.x.z` annotation 实现，必须先修正 coordinate contract。

### 标注路径

freehand 的 `paths` 存 `page` 坐标点：

```ts
paths: Point[][] // every point is pageCss
```

freehand 的 `pageRect` 是全部 `paths` 点集的 bounding box；保存和更新时都必须重新计算。

渲染时按当前 capture origin 转成 capture/display 坐标。

## 15. Browser / session lifecycle

### Browser 模型

- 单 server 进程维护一个 Playwright Browser singleton。
- 每个 Markit session 独立 `BrowserContext + Page`。
- session 间不共享 cookie/localStorage/sessionStorage。
- server 只监听 `127.0.0.1`。

### TTL 和清理

- session 30 分钟无 action 自动进入 `expired`。
- server 用固定间隔 sweeper（例如 60s）扫描 idle session；每次 action/navigate 前也做一次 check-on-action，避免 orphaned BrowserContext 长时间存活。
- expired 时关闭 Page 和 BrowserContext。
- `DELETE /api/sessions/:id` 在 V1 是 archive 语义：关闭 Page/Context，把 session 标成 `archived`，不物理删除 SQLite row。
- archived session 默认不出现在 recent sessions；已保存 bug/export 必须保留，相关 capture 默认保留，供 bug detail / export 回看。
- 物理 purge 不进 V1；若后续新增 purge，必须显式二次确认，并单独处理 capture 文件清理。
- app 退出时关闭 browser。

### 重启恢复

- DB 中 session 恢复为 `inactive`。
- `archived` session 重启后保持 `archived`，不自动恢复到 recent list。
- 打开 inactive session 时，server 新建 BrowserContext/Page，导航到 `currentUrl`。
- 重启后不承诺恢复菜单展开、表单输入等运行态；历史 capture/bug 仍完整可看。

### 本地隐私边界

- 截图、DOM target、export 默认落盘到 `.markit/`。
- UI 在首次使用时提示：不要对不希望本地落盘的敏感页面截图。
- 不读取浏览器密码、cookies 文件、Chrome profile。
- 第一版不接用户真实 Chrome 登录态。

## 16. API

### Local API safety

- `POST /api/sessions`、`POST /api/sessions/:id/navigate`、`POST /api/sessions/:id/viewport` 只接受 `http:` 和 `https:` URL；拒绝 `file:`、`data:`、`javascript:`、`about:`、`chrome:` 和空 scheme，并返回 `400 invalid_url_scheme`。
- server 只监听 `127.0.0.1`，且不得返回 `Access-Control-Allow-Origin: *`。
- 浏览器请求如果带 `Origin`，其值必须匹配 Markit 当前 web origin（dev 下通过同源 `/api/*` proxy 访问）；不匹配时返回 `403 origin_not_allowed`。
- V1 不支持第三方站点直接跨 origin 调 Markit API；所有浏览器态写操作默认走同源 JSON 请求。

### Session create

`POST /api/sessions` 请求：

```ts
type CreateSessionRequest = {
  url: string;
  viewport?: Viewport;
  capturePolicy?: 'viewport' | 'fullPage' | 'none';
};
```

响应：

```ts
type CreateSessionResponse = {
  session: MarkitSession;
  capture?: MarkitCapture;
};
```

默认 `capturePolicy='viewport'`。创建成功后 server 立即导航并生成第一张 viewport capture，除非显式传 `none`。

Session：

```text
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/:id/captures
GET  /api/sessions/:id
POST /api/sessions/:id/navigate
POST /api/sessions/:id/viewport
POST /api/sessions/:id/actions
DELETE /api/sessions/:id
```

- `DELETE /api/sessions/:id` 在 V1 表示 archive session，不是 hard delete。
- `GET /api/sessions` 默认不返回 `archived` session；bug detail / export 仍可通过 bug 入口访问历史 capture。

Capture：

```text
POST /api/sessions/:id/captures
GET  /api/captures/:id
GET  /api/captures/:id/image
GET  /api/captures/:id/dom-targets
```

Annotation：

```text
POST /api/captures/:id/annotations
PATCH /api/annotations/:id
DELETE /api/annotations/:id
```

Bug：

```text
GET  /api/bugs
POST /api/bugs
GET  /api/bugs/:id
PATCH /api/bugs/:id
POST /api/bugs/:id/annotations
DELETE /api/bugs/:id/annotations/:annotationId
POST /api/bugs/:id/export
```

Settings：

```text
GET   /api/settings
PATCH /api/settings
```

AI：

```text
GET  /api/ai/status
POST /api/ai/normalize-bug
GET  /api/ai/jobs/:jobId
POST /api/ai/jobs/:jobId/cancel
```

## 17. AI Requirement Normalizer 与公司模型接入

目标：把“标注 + 口语 comment”变成标准 bug/需求草稿，减少 Figma 标注、飞书表格、口头描述之间的信息损耗。

### 产品判断

- 不建议把 Markit 做进 `/Users/xin/auto-skills/CtriXin-repo/agent-soul-company-auth`。
- `agent-soul-company-auth` 更适合作为 company auth / model capability 的参考和后续 provider。
- Markit 保持独立：页面标注、capture、bug evidence 是 Markit 的核心域；模型与 LDAP 是可替换集成层。

### 输入上下文

```ts
type NormalizeBugRequest = {
  sessionId: string;
  bugId?: string;
  captureId: string;
  annotationIds: string[];
  sourceText: string;
  strictness: 'strict' | 'draft';
  existingDraft?: Partial<BugRequirementDraft>;
  clarificationAnswers?: Array<{ questionId: string; answer: string }>;
  includeCropImages?: boolean;
};
```

server 组装给模型的上下文：

- 用户口语描述。
- 当前 bug draft 字段。
- annotation note、kind、geometry 摘要。
- element target 的 `selector/role/label/text/htmlHint` 摘要。
- capture 的 URL、viewport、scroll、createdAt。
- 可选 crop image；默认关闭。

### 输出契约

```ts
type NormalizeBugResponse =
  | { kind: 'draft'; draft: BugRequirementDraft; modelTraceId: string; unresolvedFields: string[] }
  | (BugClarificationRequest & { modelTraceId: string; unresolvedFields: string[] });

type NormalizeBugJobCreateResponse = {
  jobId: string;
  status: 'queued' | 'running';
};

type NormalizeBugJobResponse = {
  job: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'clarification_required' | 'failed' | 'stale' | 'cancelled';
    result?: NormalizeBugResponse;
    error?: { code: 'ai_provider_disabled' | 'ai_provider_failed' | 'ai_response_invalid' | 'ai_job_stale'; message: string };
    createdAt: string;
    updatedAt: string;
  };
};
```

模型必须只返回 structured JSON。server 负责 schema validate；失败时返回 `ai_response_invalid`，前端保留用户原文，不覆盖 bug 表单。

### Clarification 交互

模型反馈有延迟，所以不做一问一答的同步 wizard。采用异步 job：

```text
POST /api/ai/normalize-bug -> 202 { jobId }
GET  /api/ai/jobs/:jobId
```

UI 状态：

- `queued/running`：右侧显示 compact progress，不锁住标注和表单。
- `clarification_required`：一次展示最多 3 个问题，按 `target -> actual/expected -> severity/scope` 排序。
- 用户可以逐条回答，回答内容先存在本地 draft；点击 `Update draft` 后再提交一轮 normalize。
- 已经高置信的字段显示在 partial draft 中，但带 “AI suggestion” 标记；只有用户 `Apply to bug` 后才写入 bug。
- 如果用户继续改标注或切 capture，旧 job 标成 `stale`，结果不自动覆盖当前 panel。

问题策略：

- 默认 batch 提问，避免每个问题都等一次 LLM。
- 一轮最多 3 个问题，避免把标注者变成填长表。
- 只问会改变 bug 语义的问题；纯文案润色不反问。
- 对每个问题允许提供 2-3 个 suggestion chips，但必须保留自由输入。

### Prompt 边界

模型任务不是“判断设计对错”，而是整理成可执行需求/bug：

- 用标注证据和用户原文提炼 `actual`。
- 用用户表达或 UI 规范推断 `expected`；无法确定就反问。
- `acceptanceCriteria` 必须可验收，例如“在 390x844 viewport 下，菜单按钮完整可见”。
- 不要输出“优化一下”“感觉不好”这种不可验收描述。
- 不确定时最多问 3 个问题，每个问题必须说明缺的决策是什么。
- strict 模式下，只要模型需要“猜”，就返回 clarification，不返回完整 draft。

### Provider 选择

V1 fresh checkout 必须不依赖公司 LDAP 或远端配置。Provider 决议如下：

1. `off`：默认值。无配置时 Normalize disabled，其他功能完整可用。
2. `mock`：测试专用，固定返回 draft/clarification fixtures，不调用模型。
3. `openai-compatible`：V1 唯一正式实现路径，读取 `MARKIT_MODEL_BASE_URL`、`MARKIT_MODEL_API_KEY`、`MARKIT_MODEL_ID`。
4. `local-mms-mmf`：V1 optional adapter，只读本机 route file；文件不存在时自动降级到 `off`，不阻塞启动。
5. `company-persona`：V1 不实现登录和 LDAP，只保留 adapter interface 与设置占位；进入公司部署 milestone 时再接。

`local-mms-mmf` route file 最小契约：

```json
{
  "defaultModel": "qwen3-max",
  "routes": {
    "qwen3-max": {
      "baseUrl": "http://127.0.0.1:4000/openai/v1",
      "apiKeyEnv": "MARKIT_MODEL_API_KEY",
      "model": "qwen3-max",
      "endpoint": "chat.completions"
    }
  }
}
```

- 默认路径：`~/.config/mms/model-routes.json` 或 `MARKIT_MMF_ROUTES`。
- `apiKeyEnv` 只引用 env name，不把 key 写入 route file。
- 只支持 OpenAI-compatible JSON response；Anthropic/messages 等 bridge 不进 V1。
- 读取失败、模型缺失、key 缺失都返回 `ai_provider_disabled`，不影响 capture/annotation/export。

OpenAI-compatible 调用契约：

```ts
type OpenAICompatibleNormalizeCall = {
  endpoint: 'POST /chat/completions';
  body: {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: 0;
    response_format: { type: 'json_object' };
  };
};
```

如果 provider 不支持 `response_format`，server 仍要求模型只回 JSON，并用 schema validation 拒绝非 JSON 输出。

`company-persona` 的目标形态：

- 用户用公司 LDAP 登录 Markit。
- Markit server 只拿 session，不落 provider key。
- 可用模型和默认模型来自公司 model group。
- AI normalizer 调用公司 server-side provider，不暴露真实 NewAPI/OpenAPI key。

### 隐私与可追踪

- 默认不把整张 screenshot 发给模型。
- 默认只发文本化上下文；用户打开 `includeCropImages` 后才发送 crop。
- `ai-runs/ai_xxx.json` 保存 request 摘要、response、model、latency、schema validation result；不保存 provider key。
- 导出 evidence 时可选择包含 AI draft trace，但默认只包含最终人工确认后的 bug 字段。

## 18. Evidence export 契约

多 capture bug 按 capture 分组导出。

```text
.markit/exports/bug_xxx/
  bug.md
  bug.json
  captures/
    cap_001/
      screenshot.png
      screenshot.annotated.png
      metadata.json
      dom-targets.json
      crops/
        ann_001.png
        ann_002.png
    cap_002/
      screenshot.png
      screenshot.annotated.png
      metadata.json
      dom-targets.json
      crops/
        ann_003.png
```

`bug.md` 必须包含：

- title。
- severity/status。
- actual/expected。
- source URL / final URL。
- viewport。
- capture time。
- annotations grouped by capture。
- screenshot/crop 相对路径。
- 如果 bug 来自 AI normalizer，只包含人工确认后的字段；不默认导出原始模型 trace。

`bug.json` 必须包含完整结构化 payload，可供后续 Feishu sink 使用。

导出排序：

- capture 按 `createdAt` 升序。
- annotation 在每个 capture 内按 `sortOrder` / `bug_annotations.sort_order` 升序。
- 如果 `sortOrder` 缺失，按 annotation `createdAt` 升序兜底。

## 19. 从 OpenDesign 复用的点

参考但不整搬：

- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/PreviewDrawOverlay.tsx:48`：overlay 组件边界；参考 canvas resize/redraw、undo/redo、note toolbar、screenshot composition，不复用 DOM iframe 逻辑。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/PreviewDrawOverlay.tsx:258`：stroke bounds 与 target bounds 合并逻辑；Markit 改成 `pageRect/captureRect`。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/comments.ts:13`：`PreviewCommentSnapshot` 字段结构；Markit 只借鉴 target snapshot 形状。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/comments.ts:77`：snapshot -> persisted target normalize；Markit 改成 `DomTarget` + annotation geometry。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/comments.ts:208`：visual annotation attachment；Markit 改成 local evidence export，不进入 chat attachment。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/runtime/srcdoc.ts:955`：`visibleTarget` 和 meaningful target 判断；Markit 改成 Playwright `page.evaluate`。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/runtime/srcdoc.ts:1013`：DOM target payload 组装；Markit 保留 selector/label/text/htmlHint/position 思路。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/runtime/srcdoc.ts:1300`：click target + free-pin fallback；Markit 对应 element pick + pin fallback。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/FileViewer.tsx:2857`：comment overlay layer 和 saved marker；Markit 只复用视觉层级思路。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/FileViewer.tsx:2953`：target overlay 渲染；Markit 改成 screenshot canvas overlay。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/FileViewer.tsx:4777`：iframe message -> live targets；Markit 改成 server capture 后读取 `dom-targets.json`。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/web/src/components/FileViewer.tsx:6255`：comment composer popover；Markit 改成右侧 bug panel，不做 floating composer。
- `/Users/xin/auto-skills/installed-skills/open-design/apps/daemon/src/db.ts:108`：`preview_comments` schema 的持久化思路；Markit 使用独立 SQLite schema，不复用 project/conversation 外键。

不复用：

- ChatComposer。
- OpenDesign project/conversation/run。
- deploy/template/tweaks/manual edit。
- 18 语言 i18n。
- 巨型 FileViewer 状态机。

## 20. 组件拆分

Web：

```text
apps/web/src/
  pages/HomePage.tsx
  pages/SessionPage.tsx
  pages/BugsPage.tsx
  pages/BugDetailPage.tsx
  pages/SettingsPage.tsx
  components/shell/AppShell.tsx
  components/session/UrlToolbar.tsx
  components/session/CaptureRail.tsx
  components/session/BrowserControls.tsx
  components/canvas/MarkitCanvas.tsx
  components/canvas/AnnotationLayer.tsx
  components/canvas/tools/PinTool.tsx
  components/canvas/tools/RectTool.tsx
  components/canvas/tools/FreehandTool.tsx
  components/canvas/tools/ElementPickTool.tsx
  components/ai/RequirementNormalizerPanel.tsx
  components/ai/ClarificationQuestions.tsx
  components/bug/BugPanel.tsx
  components/bug/BugForm.tsx
  components/bug/BugCard.tsx
  components/bug/EvidenceStrip.tsx
  styles/tokens.css
  styles/base.css
  styles/workspace.css
  styles/annotations.css
```

Server：

```text
apps/server/src/
  index.ts
  config.ts
  db/schema.ts
  db/migrations.ts
  db/sessions.ts
  db/captures.ts
  db/annotations.ts
  db/bugs.ts
  renderer/browser.ts
  renderer/sessions.ts
  renderer/actions.ts
  renderer/capture.ts
  renderer/dom-targets.ts
  routes/sessions.ts
  routes/captures.ts
  routes/annotations.ts
  routes/bugs.ts
  routes/ai.ts
  routes/settings.ts
  ai/provider.ts
  ai/normalizer.ts
  ai/prompt.ts
  ai/schema.ts
  export/compose-annotated-image.ts
  export/crop.ts
  export/markdown.ts
  export/manifest.ts
```

## 21. 小步迭代计划与机器验收

### 21.1 x.y.z 编号规则

- `x` 表示里程碑层：`0` bootstrap，`1` contracts/storage，`2` capture runtime，`3` workspace UI，`4` browse action，`5` annotation，`6` bug workflow，`7` export，`8` AI normalizer，`9` settings/stability，`10` final readiness。
- `y` 表示可独立落地的 vertical slice；`z` 表示该 slice 内的最小可验证 patch。
- 每个 `x.y.z` 必须能用 1 个窄 commit 或 1 个窄 PR 描述；不要把多个 UI、DB、runtime 风险塞进同一步。
- 每步都要写清：交付面、验收命令或手测证据、下一步解锁条件。
- 如果某步验收失败，新增同前缀的修复步，例如 `2.4.1`，不要扩大原 `2.4.0` 范围。

### 21.2 每步通用 done gate

- `pnpm typecheck` 通过，除非该步还没有 TypeScript workspace；此时记录“not-applicable: workspace not bootstrapped”。
- `pnpm test` 或该步声明的最小测试命令通过；新增 behavior 必须有 unit/integration/e2e 之一覆盖。
- 新增 API 或 contract 必须有 schema/example payload；新增 DB 结构必须有 migration smoke test。
- 新增 UI 必须有可打开页面或 Playwright smoke；视觉不得出现 OpenDesign chat/project/run 相关 UI。
- 新增 screenshot/annotation/export 功能必须保留 CSS pixel invariant：`scale: 'css'`，`1 image pixel == 1 CSS pixel`。

### 0.1.0 Repo bootstrap contract

交付：根 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`、`README.md` 占位。

验收：

```bash
pnpm install
pnpm typecheck
```

解锁：workspace 包目录可以被 pnpm 识别，`.markit/`、`node_modules/`、`dist/`、Playwright report、`.DS_Store` 不会进入 git。

### 0.1.1 Workspace package skeleton

交付：创建 `apps/web`、`apps/server`、`packages/contracts`、`packages/annotation-core`、`packages/ai-normalizer`、`packages/issue-sinks`，每包有 `package.json`、`tsconfig.json`、空测试入口。

验收：

```bash
pnpm -r exec tsc --noEmit
pnpm -r test -- --run
```

解锁：所有包可独立 typecheck/test，尚不要求业务实现。

### 0.1.2 Root scripts contract

交付：根脚本 `dev`、`typecheck`、`test`、`build`、`probe:pixels` 落地；package-scoped scripts 与根脚本一致。

验收：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm probe:pixels
```

解锁：即使功能是 stub，命令也必须稳定返回明确 pass/fail，不允许缺脚本。

### 0.2.0 Fixture test-site baseline

交付：`fixtures/test-site/index.html`、`countries.html`、`methodology.html`，包含 header、mobile hamburger、countries dropdown、cards、long scroll page、form input。

验收：

```bash
pnpm --filter @markit/server test -- --run fixture
```

解锁：后续 capture、DOM target、browse action、pixel probe 都用同一 fixture，不靠外网验证核心行为。

### 0.3.0 Server health and local bind

交付：Express server、`GET /api/health`、只监听 `127.0.0.1`、基础错误 envelope。

验收：

```bash
pnpm --filter @markit/server test -- --run health
pnpm --filter @markit/server dev
curl http://127.0.0.1:PORT/api/health
```

解锁：web 可以通过同源 proxy 调 server；server 不返回 `Access-Control-Allow-Origin: *`。

### 0.4.0 Web empty shell

交付：Vite + React shell、基础 route、tokens.css、首页空态、API health badge。

验收：

```bash
pnpm --filter @markit/web test -- --run smoke
pnpm dev
```

解锁：`pnpm dev` 一条命令启动 web + server；浏览器打开首页不需要第二条命令。

### 0.5.0 Pixel probe baseline

交付：Playwright probe，用 fixture 验证 `scale: 'css'` 的 viewport screenshot 尺寸等于 viewport CSS size。

验收：

```bash
pnpm probe:pixels
```

解锁：后续所有 screenshot 和坐标实现必须复用该 probe，不得退回 device pixel 坐标。

### 1.1.0 Core DTO contracts

交付：`Rect`、`Point`、`Viewport`、`MarkitSession`、`MarkitCapture`、`DomTarget`、`MarkitAnnotation`、`MarkitBug`、`MarkitBugAnnotation` 类型与 runtime schema。

验收：

```bash
pnpm --filter @markit/contracts test -- --run dto
pnpm typecheck
```

解锁：server/web 只能从 `packages/contracts` 引入共享 DTO，不复制类型。

### 1.1.1 Action and API contracts

交付：`MarkitActionRequest/Response`、API error code、session/capture/annotation/bug/settings/AI request-response schema。

验收：

```bash
pnpm --filter @markit/contracts test -- --run api-contracts
```

解锁：routes 可以按 schema validate 输入输出；错误码不在 handler 里临时造字符串。

### 1.1.2 AI normalizer contracts

交付：`BugRequirementDraft`、`BugClarificationRequest`、`NormalizeBugRequest/Response`、job response schema、fixtures。

验收：

```bash
pnpm --filter @markit/contracts test -- --run ai-contracts
pnpm --filter @markit/ai-normalizer test -- --run schema
```

解锁：AI provider 可以先 mock，UI 可先按 contract 渲染。

### 1.2.0 SQLite migration runner

交付：SQLite connection、transactional migration runner、`schema_migrations`、`PRAGMA foreign_keys=ON`。

验收：

```bash
pnpm --filter @markit/server test -- --run migrations
```

解锁：empty DB -> latest schema 可重复执行；`PRAGMA user_version` 只做诊断。

### 1.2.1 Storage repositories

交付：settings、sessions、captures、annotations、bugs、bug_annotations、ai_jobs、ai_runs repositories，包含 insert/get/list/update 基础路径。

验收：

```bash
pnpm --filter @markit/server test -- --run repositories
```

解锁：业务 route 不直接拼 SQL；join table 是 bug 与 annotation 归属的唯一真相。

### 1.3.0 Annotation geometry core

交付：display/capture/page/viewport 坐标转换、rect normalize、path bounds、hit-test 纯函数。

验收：

```bash
pnpm --filter @markit/annotation-core test -- --run geometry
```

解锁：UI 和 export 复用同一坐标函数；roundtrip 误差小于 `0.5px`。

### 2.1.0 Session runtime manager

交付：Playwright browser manager、session page map、TTL 状态、runtimeStatus 映射。

验收：

```bash
pnpm --filter @markit/server test -- --run runtime-manager
```

解锁：server 能为同一个 Markit session 复用 page，并能在 inactive 后重建 runtime page。

### 2.1.1 URL safety gate

交付：URL validate，只接受 `http:` 和 `https:`；拒绝 `file:`、`data:`、`javascript:`、`about:`、`chrome:` 和空 scheme。

验收：

```bash
pnpm --filter @markit/server test -- --run url-safety
```

解锁：`POST /api/sessions` 和 `POST /api/capture-url` 都返回 `400 invalid_url_scheme` 覆盖非法 scheme。

### 2.2.0 Create session + first capture API

交付：`POST /api/sessions`，支持 `url`、`viewport`、`capturePolicy`，默认生成第一张 viewport capture。

验收：

```bash
pnpm --filter @markit/server test -- --run create-session
```

解锁：创建 session 后有 session row、capture row、screenshot file、metadata file。

### 2.2.1 Navigation and viewport API

交付：`GET /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/navigate`、`POST /api/sessions/:id/viewport`。

验收：

```bash
pnpm --filter @markit/server test -- --run session-api
```

解锁：navigation/action/viewport change 后 `sessionVersion` 递增，stale client 可被识别。

### 2.3.0 Viewport and full-page capture

交付：`POST /api/sessions/:id/captures`，支持 `viewport` 和 `fullPage`，保存 screenshot、metadata、scroll、imageSize。

验收：

```bash
pnpm --filter @markit/server test -- --run capture
pnpm probe:pixels
```

解锁：fixture viewport screenshot 尺寸等于 viewport CSS size；fullPage 高度大于 viewport。

### 2.4.0 DOM target collection

交付：capture 后采集 visible targets，生成 selector、selectorKind、selectorScore、pageRect、viewportRect、captureRect、htmlHint。

验收：

```bash
pnpm --filter @markit/server test -- --run dom-targets
```

解锁：fixture button/link/header 可被采集；hidden/display none/pointer-events none 不进入 targets。

### 2.4.1 Deterministic target scoring and pick

交付：selectorScore deterministic 计算、重叠 target pick 算法、hover 单目标选择。

验收：

```bash
pnpm --filter @markit/annotation-core test -- --run target-pick
pnpm --filter @markit/server test -- --run selector-score
```

解锁：同一 DOM 同一次 capture 分数不依赖遍历顺序；面积最小优先，面积相同按 selectorScore。

### 2.5.0 Capture read APIs and static image serving

交付：`GET /api/captures/:id`、`GET /api/captures/:id/image`、`GET /api/captures/:id/dom-targets`。

验收：

```bash
pnpm --filter @markit/server test -- --run capture-read
```

解锁：web 不直接读 `.markit/`，只通过 API 读取 capture 和图片。

### 2.6.0 Web URL intake to screenshot display

交付：首页 URL input、viewport preset、Open session；session 页面展示第一张 screenshot。

验收：

```bash
pnpm --filter @markit/web test -- --run intake
pnpm test -- --run e2e-intake
```

解锁：输入 fixture URL 或 localhost URL 后，用户能看到截图。

### 3.1.0 App shell visual foundation

交付：tokens.css、base.css、workspace.css、AppShell；使用 `--mk-*` token，视觉为 OpenDesign viewer 精简版。

验收：

```bash
pnpm --filter @markit/web test -- --run shell
```

解锁：不出现 AI hero、紫色渐变、玻璃拟态、大插画、后台表格主视觉。

### 3.2.0 Home and recent sessions

交付：首页 URL intake、default viewport、recent sessions list、continue session。

验收：

```bash
pnpm --filter @markit/web test -- --run home
```

解锁：Enter 创建 session，recent item 能回到 session。

### 3.3.0 Session three-column layout

交付：Top Bar、Left Rail、Canvas、Right Panel 三栏布局，desktop/mobile responsive。

验收：

```bash
pnpm test -- --run e2e-session-layout
```

解锁：Playwright UI test 能找到三栏结构；移动窄屏可滚动或折叠，不遮挡主要操作。

### 3.4.0 Toolbar and viewport selector

交付：URL display/input、Back、Forward、Reload、Viewport selector、Capture viewport、Capture full page、Open in browser、Session status。

验收：

```bash
pnpm --filter @markit/web test -- --run toolbar
pnpm test -- --run e2e-viewport-selector
```

解锁：切换 viewport 触发 capture；session status 正确显示 loading/error/stale。

### 3.5.0 Capture rail and session bugs rail

交付：captures list、session bugs list、点击 capture 切换 canvas、点击 bug 高亮关联标注。

验收：

```bash
pnpm --filter @markit/web test -- --run capture-rail
```

解锁：UI state 不依赖 hardcoded fixture；来自 API 数据。

### 3.6.0 Canvas viewport, zoom, pan

交付：screenshot canvas、annotation overlay 容器、zoom/pan、display <-> capture transform。

验收：

```bash
pnpm --filter @markit/web test -- --run canvas
pnpm --filter @markit/annotation-core test -- --run geometry
```

解锁：zoom/pan 后坐标不漂移；annotation 工具可挂接。

### 3.7.0 Right bug panel skeleton

交付：Title、Severity、Status、Actual、Expected、Annotations、Source URL、Final URL、Viewport、Capture time、Save/Export/Copy 按钮骨架。

验收：

```bash
pnpm --filter @markit/web test -- --run bug-panel
```

解锁：字段和 Save disabled 规则可接入真实 bug workflow。

### 4.1.0 Browse mode action API

交付：`POST /api/sessions/:id/actions` 基础 route，支持 `baseSessionVersion`、action policy、stale response。

验收：

```bash
pnpm --filter @markit/server test -- --run action-api
```

解锁：所有 browse action 都通过同一 stale/loading/error 处理。

### 4.1.1 Click action and recapture

交付：click 使用 viewport 坐标作用到 Playwright page，action 后按 policy 生成 viewport capture。

验收：

```bash
pnpm --filter @markit/server test -- --run action-click
pnpm test -- --run e2e-click-dropdown
```

解锁：fixture dropdown click 后新 capture 显示展开状态。

### 4.1.2 Scroll action and debounce

交付：scroll action、debounce recapture、metadata.scroll 更新。

验收：

```bash
pnpm --filter @markit/server test -- --run action-scroll
```

解锁：scroll 后 capture metadata.scroll 变化；fullPage 审阅不允许在远端位置直接 click。

### 4.1.3 Type and key actions

交付：type、key press、focus target 处理、输入后 recapture。

验收：

```bash
pnpm --filter @markit/server test -- --run action-type
pnpm test -- --run e2e-type-form
```

解锁：fixture form input 可输入并出现在新 capture 中。

### 4.1.4 Reload and navigation controls

交付：reload、back、forward、navigate，统一 sessionVersion 递增和错误处理。

验收：

```bash
pnpm --filter @markit/server test -- --run action-navigation
```

解锁：Top Bar browser controls 有真实行为。

### 4.2.0 Browse/Annotate mode integration

交付：Canvas 上 Browse 模式转发 click/scroll/type/key；Annotate 模式不操作真实页面。

验收：

```bash
pnpm test -- --run e2e-browse-annotate-mode
```

解锁：用户能在目标状态和截图标注之间切换，模式不串行为。

### 4.3.0 Action error states

交付：navigation_failed、session_expired、stale_session、action_failed UI 和 API error mapping。

验收：

```bash
pnpm --filter @markit/server test -- --run action-errors
pnpm --filter @markit/web test -- --run error-states
```

解锁：失败不会破坏当前 capture 和 draft bug。

### 5.1.0 Annotation persistence API

交付：`POST /api/captures/:id/annotations`、`PATCH /api/annotations/:id`、`DELETE /api/annotations/:id`，geometry 从 `pageRect + capture metadata` 重新派生。

验收：

```bash
pnpm --filter @markit/server test -- --run annotation-api
```

解锁：annotation CRUD 不依赖 bug workflow。

### 5.1.1 Pin tool

交付：PinTool、快捷键 `P`、note/colorRole、保存到 SQLite。

验收：

```bash
pnpm test -- --run e2e-pin-tool
```

解锁：右侧无 active bug draft 时，新建 pin 自动创建 draft bug 但不自动填 actual/expected。

### 5.1.2 Rect tool

交付：RectTool、快捷键 `R`、drag create、resize/edit、保存 geometry。

验收：

```bash
pnpm test -- --run e2e-rect-tool
```

解锁：viewport capture 下 `pageRect = captureRect + scroll`。

### 5.1.3 Freehand tool

交付：FreehandTool、快捷键 `D`、path normalize、bounds、undo current stroke。

验收：

```bash
pnpm --filter @markit/annotation-core test -- --run freehand
pnpm test -- --run e2e-freehand-tool
```

解锁：path export 能生成 crop bounds。

### 5.1.4 Element pick tool

交付：ElementPickTool、快捷键 `E`、hover highlight、click attach target、miss fallback pin。

验收：

```bash
pnpm test -- --run e2e-element-pick
```

解锁：使用 `DomTarget.captureRect` 高亮正确；无 target 时生成 pin annotation。

### 5.2.0 Annotation edit/delete and relations cleanup

交付：annotation edit/delete UI；删除 annotation 时删除 `bug_annotations` relation，不删除 bug。

验收：

```bash
pnpm --filter @markit/server test -- --run annotation-delete-relations
pnpm test -- --run e2e-annotation-edit-delete
```

解锁：bug relation 与 annotation 原始记录不会失同步。

### 5.3.0 Keyboard shortcuts

交付：`B`、`V`、`P`、`R`、`D`、`E`、`C`、`Esc`、`Cmd/Ctrl+S`，并避免输入框内误触。

验收：

```bash
pnpm --filter @markit/web test -- --run shortcuts
```

解锁：核心工作台可键盘驱动。

### 6.1.0 Bug CRUD API

交付：`GET /api/bugs`、`POST /api/bugs`、`GET /api/bugs/:id`、`PATCH /api/bugs/:id`。

验收：

```bash
pnpm --filter @markit/server test -- --run bug-api
```

解锁：bug 可以零 annotation 保存，但 UI/API 明确提示“无标注 evidence”。

### 6.1.1 Bug save validation

交付：title、actual、expected、severity 必填约束；Save disabled 和 server validation 同步。

验收：

```bash
pnpm --filter @markit/server test -- --run bug-validation
pnpm --filter @markit/web test -- --run bug-form-validation
```

解锁：前端不能绕过必填字段保存无效 bug。

### 6.2.0 Bug annotation relation API

交付：`POST /api/bugs/:id/annotations`、`DELETE /api/bugs/:id/annotations/:annotationId`，sortOrder 维护。

验收：

```bash
pnpm --filter @markit/server test -- --run bug-annotation-relations
```

解锁：多 annotation 可挂到同一 bug；从 bug 移除 annotation 只删 relation。

### 6.3.0 Bug panel active draft rules

交付：active draft/open bug 与新 annotation 绑定规则；手动移除 relation；primary capture 更新。

验收：

```bash
pnpm test -- --run e2e-active-draft-rules
```

解锁：标注不会变成模糊 comment；右侧 bug panel 是唯一编辑焦点。

### 6.4.0 Bug inbox

交付：`/bugs` 卡片 list、All/Draft/Open/Resolved filter、severity filter。

验收：

```bash
pnpm --filter @markit/web test -- --run bug-inbox
```

解锁：用户能脱离 session 查看本地 bug。

### 6.5.0 Bug detail

交付：`/bugs/:bugId`，展示 annotated screenshot、crops 占位、Actual/Expected、URL、viewport、timestamp、按 capture 分组 annotations、resolve/reopen。

验收：

```bash
pnpm test -- --run e2e-bug-detail
```

解锁：evidence export 可在 detail 页面接入。

### 7.1.0 Export manifest and grouping

交付：export service 按 bug 聚合 session、captures、annotations，按 capture 分组并稳定排序。

验收：

```bash
pnpm --filter @markit/server test -- --run export-manifest
```

解锁：multi-capture bug 导出结构确定。

### 7.1.1 Annotated screenshot composition

交付：`screenshot.annotated.png` 生成，覆盖 pin/rect/freehand/element 色彩语义。

验收：

```bash
pnpm --filter @markit/server test -- --run annotated-image
```

解锁：机器能检测到标注色像素。

### 7.1.2 Crop generation

交付：每个 annotation 生成 crop，支持 path bounds 和 target bounds。

验收：

```bash
pnpm --filter @markit/server test -- --run export-crops
```

解锁：每个 annotation 都有 crop；bounds 不越界。

### 7.1.3 Markdown and JSON export

交付：`bug.md`、`bug.json`，包含 title、severity/status、actual/expected、source/final URL、viewport、capture time、annotation group、相对路径。

验收：

```bash
pnpm --filter @markit/server test -- --run export-markdown-json
```

解锁：`bug.json` 通过 contract schema；AI trace 默认不导出。

### 7.2.0 Export API and UI actions

交付：`POST /api/bugs/:id/export`、Export evidence、Copy markdown。

验收：

```bash
pnpm test -- --run e2e-export
```

解锁：bug detail 和 right panel 都能触发 export。

### 8.1.0 AI provider status and settings contract

交付：`GET /api/ai/status`、AI settings DTO、默认 provider `off`，未配置不阻塞核心流程。

验收：

```bash
pnpm --filter @markit/server test -- --run ai-status
```

解锁：Normalize disabled 时 UI 不报错。

### 8.1.1 Mock normalizer provider

交付：mock provider fixtures，覆盖 draft、clarification、invalid schema。

验收：

```bash
pnpm --filter @markit/ai-normalizer test -- --run mock-provider
pnpm --filter @markit/server test -- --run ai-mock
```

解锁：AI UI 和 job flow 可在无真实模型时验收。

### 8.2.0 AI job queue and persistence

交付：`POST /api/ai/normalize-bug` 返回 `202 { jobId }`，`GET /api/ai/jobs/:jobId`，`POST /api/ai/jobs/:jobId/cancel`，ai_jobs 持久化。

验收：

```bash
pnpm --filter @markit/server test -- --run ai-jobs
```

解锁：用户可以继续标注/编辑，不被同步 LLM 调用锁住。

### 8.2.1 Prompt context builder

交付：只读取 active bug、关联 annotations、capture metadata、DOM target 摘要和用户 sourceText；默认不包含 screenshot bytes。

验收：

```bash
pnpm --filter @markit/ai-normalizer test -- --run prompt-context
```

解锁：隐私边界可测试；includeCropImages 另行显式开启。

### 8.3.0 OpenAI-compatible provider

交付：读取 `MARKIT_MODEL_BASE_URL`、`MARKIT_MODEL_API_KEY`、`MARKIT_MODEL_ID`，调用 `/chat/completions`，要求 structured JSON，schema validate。

验收：

```bash
pnpm --filter @markit/ai-normalizer test -- --run openai-compatible
```

解锁：正式 V1 provider 可用；非 JSON 输出返回 `ai_response_invalid`。

### 8.3.1 local-mms-mmf optional adapter

交付：读取 `~/.config/mms/model-routes.json` 或 `MARKIT_MMF_ROUTES`，只支持 OpenAI-compatible route；缺 route/key 自动降级 disabled。

验收：

```bash
pnpm --filter @markit/ai-normalizer test -- --run local-mms-mmf
```

解锁：本机 MMS route 可选接入，但 fresh checkout 不依赖它。

### 8.4.0 Normalizer panel UI

交付：Comment 输入、Normalize、Requirement Draft、Apply to bug、Ask again、Discard。

验收：

```bash
pnpm --filter @markit/web test -- --run normalizer-panel
```

解锁：AI 输出 Apply 前可编辑，Apply 后仍走 bug save validation。

### 8.4.1 Clarification UI

交付：最多 3 个 clarification questions、suggestion chips、逐条回答、本地保存 answers、Update draft。

验收：

```bash
pnpm test -- --run e2e-ai-clarification
```

解锁：缺 expected 或低置信字段时反问，不编造字段。

### 8.5.0 AI trace and stale result handling

交付：`ai-runs/ai_xxx.json` trace；用户继续改标注或切 capture 后旧 job 标 `stale`，不自动覆盖当前 panel。

验收：

```bash
pnpm --filter @markit/server test -- --run ai-trace-stale
```

解锁：AI 误解可追踪，旧结果不会覆盖新上下文。

### 9.1.0 Settings storage and page

交付：`GET /api/settings`、`PATCH /api/settings`、`/settings` 页面；Storage、Browser、Issue sinks、AI Normalizer、Advanced 区块。

验收：

```bash
pnpm test -- --run e2e-settings
```

解锁：default viewport、navigation timeout、capture default、full-page max height、AI provider/off/model/threshold 可配置。

### 9.2.0 Runtime stability settings

交付：navigation timeout、full-page max height、deviceScaleFactor、auto recapture、stale session cleanup。

验收：

```bash
pnpm --filter @markit/server test -- --run runtime-settings
```

解锁：长页面、慢页面、过期 session 都有可控行为。

### 9.3.0 Session archive and recovery

交付：`DELETE /api/sessions/:id` 表示 archive；`GET /api/sessions` 默认隐藏 archived；inactive session 重新打开重建 runtime page。

验收：

```bash
pnpm --filter @markit/server test -- --run session-archive-recovery
```

解锁：历史 bug/export 仍能访问 capture；session list 不被 archived 噪音污染。

### 9.4.0 Local API origin hardening

交付：Origin 检查、同源 `/api/*` proxy 约束、浏览器态写操作拒绝第三方 origin。

验收：

```bash
pnpm --filter @markit/server test -- --run origin-hardening
```

解锁：本地 API 不暴露给任意网页跨 origin 调用。

### 9.5.0 Error UX pass

交付：URL 失败、provider disabled、provider failed、schema invalid、export failed、filesystem failed 的用户可理解错误。

验收：

```bash
pnpm --filter @markit/web test -- --run error-ux
```

解锁：失败状态不需要看 server log 才能继续操作。

### 10.1.0 Fixture E2E happy path

交付：从 URL intake 到 capture、browse click、annotation、bug save、export 的 fixture E2E。

验收：

```bash
pnpm test -- --run e2e-happy-path
```

解锁：核心路径在本机无外网可验收。

### 10.1.1 Public URL and localhost smoke

交付：public URL smoke、localhost fixture smoke、desktop/mobile viewport smoke。

验收：

```bash
pnpm test -- --run e2e-url-smoke
```

解锁：完成标准中的 public URL、localhost URL、desktop/mobile viewport 有直接证据。

### 10.2.0 README 5 分钟启动说明

交付：README 包含安装、启动、URL capture、annotation、bug export、AI mock/provider 配置、troubleshooting。

验收：

```bash
pnpm install
pnpm dev
pnpm test
```

解锁：同事 fresh checkout 后 5 分钟内能跑起首页并完成一个 fixture bug。

### 10.3.0 Final regression gate

交付：总验收报告，覆盖 unit、server integration、fixture E2E、build、pixel probe。

验收：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm probe:pixels
```

解锁：满足第 23 节完成标准后，V1 才可标记 complete。

## 22. 内置 fixture

用于本地验收：

```text
fixtures/test-site/
  index.html
  countries.html
  methodology.html
```

包含：

- header。
- mobile hamburger。
- countries dropdown。
- cards。
- long scroll page。
- form input。

## 23. 完成标准

完成时必须满足：

- `pnpm dev` 一条命令启动。
- 输入 public URL 可截图。
- 输入 localhost URL 可截图。
- 能切 desktop/mobile viewport。
- 能 click/scroll/type 到目标状态。
- 能 pin/rect/draw/element 标注。
- 能保存 comment 和 bug。
- 配置 AI provider 或 mock 模式后，能把口语 comment 规范成可编辑的 bug/需求草稿。
- 配置 AI provider 或 mock 模式后，AI 不确定时能反问，而不是编造 expected/actual。
- 能看 bug list/detail。
- 能导出 evidence。
- 样式像 OpenDesign viewer 精简版，不像 AI 生成后台。
- README 能让同事 5 分钟跑起来。
