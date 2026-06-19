# Markit 当前交接与功能总览

Date: 2026-06-19
Owner: Codex
CLI: codex
Model: gpt-5
Session: 019ece8c-f244-7a51-9138-91355862eec8
Status: active
Repo: `/Users/xin/auto-skills/CtriXin-repo/markit`
Current HEAD: `main@fced8bd` (`feat: add issue queue presets`)

## Executive Summary

Markit 当前已经从“网页截图标注工具”扩展成一个本地测试工作台：测试人员选择项目和域名，进入真实页面操作，框选/标注问题，保存为 Bug，批量生成证据并真实提交到 GitLab Wiki Hub Work Item；提交后 Bug 会进入“已挂”队列，避免重复提交。

下一阶段重点不是重做主链路，而是继续把“项目绑定、负责人、批次、状态同步、AI 辅助”做成更稳的协作层：catalog 从 `ptc-wiki` 提供统一项目关系；负责人从 preset/localStorage 过渡到服务端/ GitLab autocomplete；GitLab 可以进一步支持 Test Run 父级 Work Item、labels/milestone/iteration、状态回写。

## User Intent

用户希望 Markit 服务于一个轻量但完整的测试提 Bug 流程：

1. 测试入口不是让人记 URL，而是先选“要测试的项目”，再选该项目绑定的域名。
2. 每个项目背后有稳定关系：folder / repo / 需求 / 项目名 / branch / domain / owner / 发布状态。
3. 标注时尽量少填：框选后能快速保存评论或转成 Bug，必要时用 AI 预填草稿。
4. Bug 提交时信息要全：截图、crop、页面信息、项目、域名、branch、负责人、P 值或优先级都要带过去。
5. GitLab 中所有人能按自己的 assignee 找到 Bug；无项目绑定的 Bug 也要进入统一 Hub，不要丢。
6. 已经提交过的 Bug 不应重复创建 Work Item，要有可见状态、loading、完成、链接和兜底 dedupe。
7. 当前阶段项目只有用户自己，默认负责人可以先用 `songxin`；后续同事增多时再做记忆、autocomplete 和服务端绑定。

明确非目标：

- 不把 `scmp-ops` 或个人本地 wiki 作为同事使用 Markit 的硬依赖。
- 不默认自动调用 LLM 介入每次框选，避免拖慢标注主流程。
- 不把多个互不相关的 Bug 塞进一个 GitLab child item；默认一个 Markit Bug 对应一个 GitLab Work Item。

## Current Runtime

本地推荐启动方式：

```bash
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki MARKIT_AI_PROVIDER=mock pnpm dev
```

默认地址：

- Web: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:4317`
- Local data: `.markit/`
- Project Catalog root: `/Users/xin/ptc-wiki`
- GitLab Hub project: `ptc/fe/ptc-wiki`

GitLab auth 当前默认：

```bash
MARKIT_GITLAB_AUTH=auto
```

优先级：

1. `MARKIT_GITLAB_TOKEN`
2. 本机 `glab api` 登录态

服务器部署时仍需要凭证，推荐用服务账号 token 或 server env token，不要把 key 写进 repo。

## Current Architecture / Boundaries

### App Ownership

- `apps/web/src/App.tsx`：主要 Web 工作台逻辑，包括首页项目/域名选择、截图工作区、标注候选、Bug 草稿、Bug list/detail、批量提交入口。
- `apps/web/src/styles/workspace.css`：工作台样式、响应式布局、Bug list 工具栏、候选标注和草稿区域视觉。
- `apps/server/src/catalog.ts`：读取 `ptc-wiki` catalog，提供项目、域名、URL resolve、assignee/labels/branch 快照。
- `apps/server/src/routes/annotations.ts`：annotation CRUD，并返回 `linkedBugId` / `linkedBugTitle`，用于过滤已转 Bug 的标注。
- `apps/server/src/routes/bugs.ts`：Bug 保存、导出、GitLab issue draft、真实 Work Item submit、assignee 解析、dedupe、uploads。
- `apps/server/src/routes/mappers.ts`：server DTO 和 client shape 的映射。
- `scripts/e2e-*.mjs`：端到端 smoke / fixture 验证。
- `README.md`：当前可运行能力和 env 配置说明。
- `.ai/agent-release-notes.md`：本地 agent release note，已被 `.gitignore` 忽略。

### Data Ownership

- `.markit/`：本地运行数据、session、captures、bugs、exports、issue-drafts。
- `.markit/exports/<bug-id>/`：Bug 证据导出目录，包含 Markdown、JSON、annotated screenshot、crop、DOM targets、额外上传的截图证据。
- `.markit/issue-drafts/*/submitted.json`：真实提交后的本地 dedupe 记录。重复提交时应返回已有链接或同步负责人，不应创建新 Work Item。
- `/Users/xin/ptc-wiki`：当前公共 catalog 根，提供项目/域名绑定。Markit 只消费它，不把业务逻辑强塞回 `scmp-ops`。

## User Testing Flow

### 1. 进入首页并选择项目

现状：

- 首页项目下拉固定高度，支持搜索。
- 项目列表只展示“有绑定域名”的可测试项目；未记录域名的项目不再作为可选项展示。
- 直接输入 URL 时，server 会尝试通过 catalog domain index 反查项目绑定。

可扩展：

- 项目搜索可以接服务端分页和更强 fuzzy search。
- 首页可以显示项目状态：当前 branch、发布时间、发布状态、owner、最近测试批次。
- 可加“最近测试项目”置顶，但不要覆盖 catalog 真实绑定。

### 2. 选择域名并开始测试

现状：

- 域名列表在 `>=10` 条时展示搜索框并支持模糊搜索。
- 选择域名后 URL 自动填入。
- session 创建时会保存 `projectSnapshot`，冻结项目名、域名、repo、branch、assignee/labels 和 catalog 生成时间。

可扩展：

- 域名可以按环境分组，例如 `dev` / `test` / `staging` / `prod`。
- 支持一个项目多个 repo 或多个前端 entry 的绑定关系。
- 支持 catalog 中记录发布版本、commit hash、构建时间。

### 3. 在真实页面中操作

现状：

- Playwright 打开真实页面，支持 public URL 和 localhost。
- Browse actions 支持 `click` / `scroll` / `type` / `key` / `reload` / `back` / `forward`。
- 支持 PC / Mobile viewport，以及 dual preview 对照。
- 支持 viewport capture 和 full-page capture。

可扩展：

- 操作历史可以保存为 repro steps。
- 对特定项目可预置登录态或 cookie profile。
- 可以加 network/log console capture，但需要注意隐私和数据量。

### 4. 截图与标注

现状：

- 标注工具包括 `pin` / `rect` / `ellipse` / `freehand` / `element` / `section`。
- 新标注先进入“待归类标注”。
- quick comment popup 支持“保存评论”和“保存为 Bug”。
- 保存为 Bug 后，该标注会从右侧候选、左侧待归类和画布候选层移除。
- 已转 Bug 的 annotation 刷新后不会回流候选，因为 API 返回了 `linkedBugId` / `linkedBugTitle`。

可扩展：

- 待归类标注可以支持批量归类、合并为一个 Bug、或一键删除。
- 已归类 Bug 可以在画布上以不同颜色轻量显示，但默认不应再占用候选输入区。
- 可加“标注图层 filter”：只看 comments、只看 Bugs、只看当前 Bug。

### 5. 保存评论或保存 Bug

现状：

- “保存评论”表示保留为待归类候选，不进入 Bug 队列。
- “保存为 Bug”会创建 Bug 草稿并从候选区移除。
- 左侧索引分为“待归类 / Bug”，用于快速回选候选标注或跳转 Bug。
- Bug 新建状态固定为 `draft`，不再要求用户在草稿阶段选择状态。

可扩展：

- 评论可以后续升级为 Bug，保留原 annotation id。
- Bug 可以支持多 annotation 关联。
- 左侧 list 可以增加按截图/capture 分组，避免长页面时混乱。

### 6. Bug 草稿与 AI 预填

现状：

- Bug 草稿主输入是“一句话描述”。
- 操作按钮压缩为 `AI 预填` / `保存 Bug`。
- AI 不自动介入；只有点击 `AI 预填` 时才调用 normalizer。
- 如果 AI 认为信息不足，会在草稿区展示 `AI 需要你补充` 卡片，并明确告诉用户填到哪个字段：`期望表现` / `实际表现` / `标题` / `一句话描述`。
- `MARKIT_AI_PROVIDER=mock` 可本地验证；也支持 `openai-compatible` 和 `local-mms-mmf`。

当前 LLM 介入点：

1. 不介入 URL 选择。
2. 不介入页面操作。
3. 不介入截图和框选。
4. 只在用户点击 `AI 预填` 时介入 Bug 草稿 normalizer。
5. 导出和 GitLab submit 默认不调用 LLM。

可扩展：

- 可选 OCR / visual detection 生成一句描述，但不要默认开启。
- 可在 Bug 草稿里做 modal 或 side toast 的 AI follow-up；当前内嵌卡片更稳。
- 可对 screenshot + DOM target + user comment 生成更完整的 reproducible issue body。
- 如果未来引入自动 AI，需要做 loading、cancel、超时、失败 fallback，不能阻塞手动保存。

### 7. Bug list、队列与详情

现状：

- Bug list 支持项目分组，避免所有 Bug 平铺混在一起。
- 队列 tabs：`待提` / `已挂` / `全部`。
- 成功挂 GitLab 后，Bug 从 `待提` 移到 `已挂`。
- 已挂 Bug 可查看 issue link、状态和提交结果。
- Bug detail 支持编辑 title / status / severity / actual / expected / refs 等字段。

可扩展：

- 队列可以增加 `处理中` / `需补充` / `提交失败`。
- 状态可以与 GitLab Work Item state 双向同步。
- 卡片可以显示 assignee、labels、P 值、提交时间、测试批次。

### 8. 批量导出与 GitLab Submit

现状：

- 支持批量选择 Bug。
- 支持 dry-run `挂到 Wiki Issue 草稿`。
- 支持真实 `挂 Wiki Issue`，提交到 GitLab Hub `ptc/fe/ptc-wiki`。
- 一个 Markit Bug 默认对应一个 GitLab Work Item / Issue。
- 提交时会上传 annotated screenshot、crop、对比截图到 GitLab uploads，并把返回 Markdown 写入 issue body。
- `.markit/issue-drafts/*/submitted.json` 用于防重复创建。
- 已挂载 Bug 再提交不会重复创建 Work Item，会返回已有链接或同步负责人。

可扩展：

- 可选创建 Test Run 父级 Work Item，Bug 作为 linked items 或 child items 关联。
- 支持选择目标 GitLab project，而不是固定 Hub。
- 支持 labels / milestone / iteration / priority / due date。
- 支持提交后刷新远端状态，回写 local issue state。

## Assignee Flow

现状负责人优先级：

1. 批量提交 payload 里的 `assignees: ["songxin", "qauser"]`。
2. catalog / `projectSnapshot.project.defaultAssignees[]`。
3. 兼容旧 `defaultAssignee`。
4. 都没有时，真实提交读取当前 GitLab 登录用户并 assign 给自己。

当前 UI：

- 批量提交输入框明确为 `GitLab 负责人 username（可选）`，不是项目名。
- 内置 `songxin` preset。
- 输入过的负责人会存入浏览器 `localStorage`，后续作为常用人选。
- 支持多人逗号分隔。

错误处理：

- 部分 username 解析失败：只展示实际应用的负责人，并记录 `unresolvedAssignees[]`。
- 全 invalid 且新建 Work Item：不写 `assignee_ids`，body 记录 `Applied Assignees: none`。
- 全 invalid 且已有 Work Item：保留远端负责人，并追加或刷新 `Markit Assignment Warning`。
- 后续成功解析时会清理旧 warning。

可扩展：

- 从 GitLab users API 拉 autocomplete。
- 从 catalog/service 拉项目默认 owner、FE owner、QA owner。
- localStorage 常用人支持删除、排序、pin。
- 支持批量提交时按 Bug 或按项目选择不同 assignee。
- 支持多人角色：`developer` / `reviewer` / `qa`。

## Project Catalog / ptc-wiki

当前 Markit 读取：

- `integrations/markit.json`
- `catalog/catalog.manifest.json`
- `catalog/domains.json`
- `catalog/projects/*.json`

当前 API：

- `GET /api/catalog/status`
- `GET /api/catalog/projects?query=...`
- `GET /api/catalog/domains?projectId=...`
- `GET /api/catalog/resolve?url=...`

已完成能力：

- 项目/域名选择。
- URL 反查项目绑定。
- session `projectSnapshot` 持久化。
- Bug export 带项目/域名/branch。
- GitLab issue body 带业务 repo / branch / binding status / assignee suggestion。
- 无项目绑定的 Bug 也能进入 Hub，并标记 `Binding Status: unbound` 和 `unbound-project` label。

建议后续 schema：

```text
projectId
projectName
folder
repo
requirementName
branch
branchStatus
releaseTime
domains[]
defaultAssignees[]
labels[]
owners[]
lastDeployedCommit
lastTestRun
```

边界：

- `ptc-wiki` 负责统一项目事实，不负责执行测试。
- Markit 负责消费 catalog 并冻结 snapshot，不负责成为 wiki 的唯一编辑器。
- `scmp-ops` 可以作为数据来源之一，但不应成为 Markit 的硬依赖。

## GitLab Work Item Strategy

当前决策：

- 默认一个 Markit Bug = 一个 GitLab Work Item。
- 不建议把多个独立 Bug 放在一个 child item 里，因为 assignee、状态、优先级、回归路径会互相污染。
- GitLab child items 适合“同一个 Bug 内拆工”，例如 `FE 修复` / `后端确认` / `QA 回归`。
- 如果需要“一次测试批次”，建议未来创建一个父级 Test Run Work Item，再通过 body 清单、linked items 或 child items 关联 Bug。

当前排序/命名意图：

- Issue 信息应包含 domain + bug name + P 值或 priority。
- 所有人可以从 GitLab assignee 过滤自己的 Bug。
- 证据需要完整，不要求用户再回 Markit 才能理解问题。

## Evidence Export

当前每个 Bug 可以导出：

- `bug.md`
- `bug.json`
- `captures/<capture-id>/screenshot.annotated.png`
- `captures/<capture-id>/crops/*.png`
- metadata
- DOM targets
- 粘贴或上传的对比截图证据
- GitLab uploads 返回的 Markdown asset refs

已验证 smoke 输出示例：

- `.agent.local/evidence/tongzhang-er-final/e2e-result.json`
- `.agent.local/evidence/public-url-smoke/result.json`
- `.agent.local/evidence/catalog-snapshot-smoke/result.json`
- `.agent.local/evidence/macromoss-real/result.json`

## Completed Work

### Project / Domain Binding

- 完成 `ptc-wiki` Project Catalog provider/API。
- 完成首页项目搜索和固定高度下拉。
- 完成域名 `>=10` 搜索与 fuzzy match。
- 完成未记录域名项目过滤。
- 完成 URL reverse resolve。
- 完成 session `projectSnapshot`。
- 完成工作台右侧截图信息显示项目、绑定域名、当前 branch。

### Annotation UX

- 完成“待归类标注”候选模型。
- 完成保存为 Bug 后从候选区和画布候选层移除。
- 完成已转 Bug annotation 刷新不回流。
- 完成左侧“待归类 / Bug”分段索引。
- 完成 Bug 草稿固定 `draft` 状态。

### Bug Draft / AI

- 完成“一句话描述”草稿入口。
- 完成 `AI 预填` 手动触发。
- 完成 AI follow-up 卡片展示，并指明补充字段。
- 完成 mock / openai-compatible / local-mms-mmf provider 支持。

### GitLab Submit

- 完成 dry-run issue draft。
- 完成真实 GitLab Work Item submit。
- 完成 GitLab uploads 截图证据。
- 完成 submitted.json dedupe。
- 完成 submit loading / success / error / link 状态回填。
- 完成已挂 Bug 不重复创建。

### Multi-assignee

- 完成手动多人 assignees。
- 完成 catalog defaultAssignees fallback。
- 完成当前 GitLab user fallback。
- 完成 partial resolve / all-invalid 行为。
- 完成 existing Work Item assignee sync 和 warning refresh/cleanup。
- 完成 `songxin` preset 和 localStorage 常用负责人。

### Validation / Review

近期完整验证已多次通过：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:tongzhang-er
```

可选 smoke：

```bash
pnpm e2e:catalog-snapshot
pnpm e2e:public-url
pnpm e2e:macromoss
pnpm probe:pixels
```

近期 review 线索：

- `25b2c7e`：multi-assignee issue submit。
- `795f4ed`：assignee sync hardening。
- `01902fe`：rereview residual closure。
- `a34200e`：final low residual cleanup。
- `f1d24ba`：catalog invalid assignee docs polish。
- `b56766c`：annotation candidate UX。
- `2447121`：draft AI follow-up polish。
- `fced8bd`：issue queue presets。

## Not Done Yet

### UI / Interaction

- 390px placeholder 可读性还可继续优化。
- 900px 中宽工具栏余量仍应继续压测，虽然当前未确认裁切。
- Bug 草稿字段还能进一步收纳，减少“甜的东西太多”的视觉负担。
- 批量工具栏在窄屏下可以继续变成更清晰的 command bar。
- 已挂队列可增加更多远端状态显示，例如 `opened` / `closed` / `updated_at`。

### Project Catalog

- `ptc-wiki` schema 还没有完全承载 folder / repo / 需求 / 项目名 / branch / domain / 发布状态的完整 lifecycle。
- 还没有服务端 UI 来编辑 catalog。
- 还没有和 CI / 发布记录自动同步 branch、发布时间、commit。
- 还没有多环境 domain 分组。

### Assignee

- 还没有 GitLab user autocomplete。
- 还没有从 service/catalog 直接拉真实人员列表。
- 还没有项目级默认多人配置 UI。
- localStorage 常用人还没有删除、排序和 pin。

### GitLab

- 还不能在 UI 里选择目标 GitLab project；当前固定 Hub。
- 还没有 Test Run 父级 Work Item。
- 还没有 linked items / child items 批次关联。
- 还没有 labels / milestone / iteration 的完整 UI。
- 还没有远端 Work Item 状态 refresh / re-sync。

### AI

- 还没有 OCR / visual detection 自动建议。
- 还没有多模态 evidence summary 的强模型验收。
- 还没有 AI 结果缓存和 cancel。
- 还没有针对项目规则的 Bug 文案模板。

### Deployment

- 服务器部署策略还未固化。
- 服务器需要明确 GitLab 凭证来源：service account token、用户 token 还是 OAuth/glab 等效方案。
- 如果多人使用，需要用户身份、权限隔离、个人 localStorage 替代方案和 audit log。

## Roadmap

### Phase 1: 当前可测闭环稳定化

目标：用户可以持续测试、提 Bug、挂 GitLab，不重复、不迷路。

建议任务：

1. 对 `fced8bd` 再跑一次截图驱动 QA。
2. 补 Bug list narrow width 视觉 polish。
3. 给已挂 Bug 增加“重新打开链接 / 复制链接 / 同步负责人”小动作。
4. 对 issue submit 加更明确的 per-card 状态：`pending` / `submitting` / `submitted` / `reused` / `failed`。

验收：

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm e2e:tongzhang-er
```

### Phase 2: Catalog 成为项目 wiki 最小真相源

目标：测试只需要选项目和域名，不需要记 repo / branch / owner。

建议任务：

1. 在 `ptc-wiki` 明确 catalog schema。
2. 增加发布状态和发布时间字段。
3. 支持 domain environment 分组。
4. Markit 首页显示 branch、owner、last release。
5. 导出和 issue body 展示这些字段。

验收：

```bash
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki pnpm e2e:catalog-snapshot
```

### Phase 3: Assignee 从手填过渡到服务绑定

目标：批量提交前可以选择一个或多个人，且来源可靠。

建议任务：

1. 增加 GitLab username autocomplete。
2. catalog 支持 `defaultAssignees[]`、`qaAssignees[]`、`reviewers[]`。
3. localStorage 常用人可管理。
4. 批量提交 UI 支持“应用到选中 Bug”。

验收：

- 手动多人、catalog 默认、当前 GitLab user fallback 都保持不退化。
- partial / all-invalid 的 warning 行为保持一致。

### Phase 4: Test Run / 批次管理

目标：一次测试有独立批次，Bug 仍保持独立 Work Item。

建议任务：

1. 增加 Markit local Test Run model。
2. 可选创建 GitLab 父级 Test Run Work Item。
3. Bug issue body 反链 Test Run。
4. Test Run 汇总域名、branch、测试时间、测试人、Bug 清单。

默认仍保持一个 Bug 一个 Work Item。

### Phase 5: AI 辅助增强

目标：AI 帮写，不抢主流程。

建议任务：

1. 对 `AI 预填` 增加截图 OCR / visual summary。
2. 根据项目模板生成 title / actual / expected / repro。
3. 增加 AI 超时、取消、重试和缓存。
4. 支持一键把 AI 提示转为用户可编辑字段，不自动提交。

## HumanGate / Safety

必须询问或显式确认的情况：

- 删除 `.markit/` 历史数据或 `.markit/issue-drafts/*/submitted.json`。
- 更换 GitLab Hub project 或真实提交到业务 repo。
- 引入服务器部署凭证、服务账号 token、OAuth 或共享身份。
- 默认开启自动 LLM 调用。
- 将多个 Bug 合并到一个 GitLab Work Item。
- 改变 `ptc-wiki` catalog schema 中已被 Markit 消费的字段语义。
- 执行 destructive git command 或删除 worktree。

可以直接做的小步工作：

- 文案和样式 polish。
- README / handoff / release note 更新。
- 不改变数据语义的 UI 信息展示。
- 增加测试覆盖和 smoke 脚本。
- 修复明显 bug，并保持现有验证通过。

## Constraints And Limitations

- 当前 repo 是本地工具项目，还未固化多人服务端权限模型。
- `ptc-wiki` 是当前公共 catalog 根，但其 schema 仍在演进。
- `glab` 登录态适合本机单人使用；服务器不能假设有同一登录态。
- GitLab Work Item API 和 GitLab Issue API 的字段差异需要继续实测，不要只按 GitHub mental model 迁移。
- `.markit/` 是本地事实源；删除或迁移前要先备份。
- AI provider 可能慢或不稳定，主流程必须允许完全不用 AI。

## Proof Strategy

基础验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

核心 E2E：

```bash
pnpm e2e:tongzhang-er
```

Catalog 验证：

```bash
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki pnpm e2e:catalog-snapshot
```

真实 URL smoke：

```bash
pnpm e2e:public-url
pnpm e2e:macromoss
```

GitLab submit 人工验收：

1. 启动 `MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki MARKIT_AI_PROVIDER=mock pnpm dev`。
2. 选择一个有域名的项目。
3. 进入页面，截图，框选。
4. 保存为 Bug。
5. 在 Bug list 勾选该 Bug。
6. 负责人使用默认 `songxin` 或输入 GitLab username。
7. 点击真实挂 Wiki Issue。
8. 验证卡片进入 `已挂`，显示 issue link。
9. 打开 GitLab Work Item，验证 body 包含截图资源、项目、域名、branch、assignee 信息。
10. 再次提交同一个 Bug，验证不重复创建，只返回已有链接或同步负责人。

## Future LMs Must Not Forget

- 结论先行：Markit 当前主链路已可测，下一步是稳定协作层，而不是重写。
- 一个 Markit Bug 默认对应一个 GitLab Work Item。
- 已提交 Bug 必须 dedupe，不能重复创建远端 Work Item。
- 保存为 Bug 的 annotation 不应再留在右侧“待归类标注”。
- 负责人输入是 GitLab username，不是项目名。
- 当前默认负责人 preset 是 `songxin`，后续应演进为 catalog/service/GitLab autocomplete。
- `ptc-wiki` 是公共 catalog 根；不要让 `scmp-ops` 或个人 wiki 成为同事必需依赖。
- AI 只在用户点击 `AI 预填` 时介入；不要默认拖慢标注。
- 服务器部署仍需要明确 GitLab 凭证策略。
- `.ai/agent-release-notes.md` 是本地 release note，改动后继续追加且不进 git。
