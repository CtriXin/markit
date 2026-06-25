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
pnpm e2e:catalog-snapshot
pnpm e2e:macromoss
pnpm dev
```

`pnpm dev` 会启动：

- API: `http://127.0.0.1:4317`
- Web: `http://127.0.0.1:5173`
- 本地数据：`.markit/`

## Handoff

- 当前长期交接与功能总览：`docs/markit-current-handoff.md`
- 生产部署与运维：`docs/markit-production-deploy.md`

## Current scope

已实现 v1 本地完整闭环：

- URL intake + recent sessions；支持 public URL 和 localhost。
- 默认单端真实 Playwright session；可切换 PC/Mobile，也可打开双端对照。
- Mobile/desktop viewport presets，Playwright screenshot 使用 CSS pixel scale。
- Browse actions：click、scroll、type、key、reload、back、forward，并自动 recapture。
- Capture actions：viewport capture 和 full-page capture。
- Annotation tools：pin、element pick、section/card 区块选择、`区域标注` 分组（rect 框选为默认，ellipse 截图式圈选、freehand 自由画保留）、最近标注撤销；右侧展示 selector/label/score。
- Bug workflow：少填字段快速保存、标注后快速评论 popup、Bug 类型 chips、保存 / 删除 bug、bug list、bug detail、status/severity/title/actual/expected 编辑、需求/Figma 引用、工作台 Cmd+V 粘贴截图、拖入/上传对比证据、annotation relation。
- Evidence export：每个 bug 生成 `bug.md`、`bug.json`、annotated screenshot、crop、metadata、DOM targets、粘贴/上传的原始截图证据。
- AI normalizer：`MARKIT_AI_PROVIDER=mock` 可本地验证；支持 `openai-compatible`、`local-mms-mmf`、`MARKIT_MMF_CONFIG` 配置文件和本机 MMS route auto-discovery。
- 通胀二 Playwright E2E：`pnpm e2e:tongzhang-er` 会启动 fixture/app，模拟 5 个飞书 bug，生成截图和解析到 `.agent.local/evidence/tongzhang-er-final/`。
- 真实公网 URL smoke：`pnpm e2e:public-url` 默认访问 `https://example.com/`，验证默认单端与可选双端真实 Playwright 渲染，证据输出到 `.agent.local/evidence/public-url-smoke/`。
- Project Catalog snapshot smoke：`pnpm e2e:catalog-snapshot` 使用临时 catalog + 本地 fixture URL，验证 URL 反查、session `projectSnapshot`、工作台项目 badge 和导出 Markdown 项目信息。
- Macromoss 真实站点 smoke：`pnpm e2e:macromoss` 访问 `https://macromoss.com/`，验证真实点击跳转、圈画、section 选择与可选双端，证据输出到 `.agent.local/evidence/macromoss-real/`。

## Project Catalog

Markit 可以读取公共 `ptc-wiki` catalog，让首页先选项目、再选该项目绑定域名；直接输入 URL 时也会按 domain index 反查项目关系。Catalog 是 optional：路径不存在或绑定文件缺失时，Markit 会 fail open，保留原来的直接 URL 流程。

```bash
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki pnpm dev
```

默认读取：

- `integrations/markit.json`
- `catalog/catalog.manifest.json`
- `catalog/domains.json`
- `catalog/projects/*.json`

API：

- `GET /api/catalog/status`
- `GET /api/catalog/projects?query=...`
- `GET /api/catalog/domains?projectId=...`
- `GET /api/catalog/resolve?url=...`

创建 session 时 Markit 会保存 `projectSnapshot`。它会固定项目名、域名、repo、branch、assignee/labels 和 catalog 生成时间，后续 catalog 更新不会改写历史 session / bug export。Bug 导出的 `bug.md` / `bug.json` 会带上对应项目信息，方便后续发布 GitLab Issue。工作台对测试/设计只暴露一个 `上报` 按钮：它会调用 GitLab API 创建到统一 Hub `ptc/fe/ptc-wiki`，返回 GitLab `web_url` 和 `/-/work_items/:iid` 路径；无项目绑定的 Bug 也进入同一 Hub，并带 `Binding Status: unbound` 与 `unbound-project` label。真实挂载会先上传 annotated screenshot、crop 和对比截图到 GitLab project uploads，再把返回的 Markdown 写进 issue body；issue body 也会包含 `markit.gitlab-issue.v1` 隐藏 metadata，labels 会追加 `project:*`、`service:*`、`repo:*`、`domain:*` 和 `type:*`，避免只靠域名判断项目。本地 `.markit/issue-drafts/*/submitted.json` 会用于防止同一 Bug 重复创建。后端仍保留 `issue-draft` dry-run 接口供 agent/debug 使用，但不作为主流程按钮展示。

负责人选择顺序已经留好扩展口：

- 批量提交请求里的 `assignees: ["songxin", "qauser"]` 优先；Bug 列表工具栏填的是 GitLab username，不是项目名，支持多人逗号分隔。工具栏内置 `songxin` 预设，输入过的负责人会记到浏览器 localStorage，后续作为本机常用人选。
- 其次使用 catalog / `projectSnapshot.project.defaultAssignees[]`，兼容旧的 `defaultAssignee`。
- 都没有时，真实提交会读取当前 GitLab 登录用户并默认 assign 给自己。
- 如果 catalog 里的默认负责人全部无法解析，新建 Work Item 不写 `assignee_ids`，body 会记录 `Applied Assignees: none` 和 `unresolvedAssignees` 线索。
- 手动 `assignees[]` 会同步已挂载 Work Item 的负责人；如果部分 username 无法解析，本地结果只展示已实际应用的负责人，并记录 `unresolvedAssignees[]`。
- 如果手动负责人全部无法解析，已挂载 Work Item 会保留原远端负责人并追加 unresolved warning；新建 Work Item 会记录 `Applied Assignees: none`；后续成功解析时会自动清理旧 warning。
- 后续如果接 service / 绑定关系，只要把查询结果转成同一个 `assignees[]` 即可，不需要改 GitLab submit 主流程。

真实提交默认 `MARKIT_GITLAB_AUTH=auto`：优先使用 `MARKIT_GITLAB_TOKEN`，没有 token 时会调用本机 `glab api` 登录态。像 GitHub `gh` 一样，先登录一次即可：

```bash
glab auth login --hostname gitlab.adsconflux.xyz
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki MARKIT_AI_PROVIDER=mock pnpm dev
```

如果要走服务器 env token：

```bash
MARKIT_GITLAB_BASE_URL=https://gitlab.adsconflux.xyz
MARKIT_GITLAB_AUTH=token
MARKIT_GITLAB_TOKEN=...
MARKIT_CATALOG_ROOT=/Users/xin/ptc-wiki MARKIT_AI_PROVIDER=mock pnpm dev
```

如果要在 GitLab Work Item 创建成功后同步到飞书 Base，开启 `MARKIT_FEISHU_SYNC=1`。默认 `MARKIT_FEISHU_AUTH=auto`：优先使用 Feishu/Lark access token；没有 token 时会调用本机 `lark-cli api --as user` 登录态，方便本地实测。默认写入当前项目问题表：app `I7m2bnPDgaYnwksqp1jcmmW9nOd`、table `tbl0yrCubWcpZCvw`。当前版本写文本字段：`域名或模板名称`、`问题现象`、`链接`、`优先级`、`项目状态`、`comment`、`备注`；也会把 GitLab 已上传的本地截图证据追加到 `附件` 字段，默认 field ID 是 `fldKBwIUX2`。飞书 `负责人` 是 user 字段，使用 `MARKIT_FEISHU_OWNER_OPEN_IDS` 写 open_id；宋鑫当前是 `ou_30c6391467af3f8ffb00e07bac50b368`。

当前实测 `lark-cli --as bot` 可以读取 Base 和字段，但创建 record 会返回 `91403 you don't have permission`；服务器默认先用 `MARKIT_FEISHU_CLI_AS=user` 或 access token，等 bot 被授予 Base 写权限后再切到 `bot`。

```bash
MARKIT_FEISHU_SYNC=1
MARKIT_FEISHU_ACCESS_TOKEN=...
# or rely on local lark-cli auth:
MARKIT_FEISHU_AUTH=auto
MARKIT_FEISHU_CLI_AS=user
MARKIT_FEISHU_ATTACHMENT_FIELD_ID=fldKBwIUX2
MARKIT_FEISHU_OWNER_OPEN_IDS=ou_30c6391467af3f8ffb00e07bac50b368
```

## AI normalizer

```bash
MARKIT_AI_PROVIDER=mock pnpm dev
```

OpenAI-compatible provider 预留环境变量；截图/对比图走多模态时加 `MARKIT_MODEL_MULTIMODAL=true`。仅在点击“AI 预填草稿”时会把草稿截图按 OpenAI-compatible `image_url` parts 发送给 provider：

```bash
MARKIT_AI_PROVIDER=openai-compatible
MARKIT_MODEL_BASE_URL=https://example.com/v1
MARKIT_MODEL_API_KEY=...
MARKIT_MODEL_ID=...
MARKIT_MODEL_MULTIMODAL=true
```

本机 MMF/MMS 通道会优先用同一套 OpenAI-compatible 形状。最少配置可以完全省掉 env：Markit 会自动读取 `~/.config/mms/generated/model-routes.json`，并按 `mimo-v2.5,qwen3.6-plus,qwen3.5-plus,MiniMax-M2.7` 顺序优先选择支持 vision 的 route。

如果要显式指定：

```bash
MARKIT_AI_PROVIDER=local-mms-mmf
MARKIT_MMF_BASE_URL=http://127.0.0.1:xxxx/v1
MARKIT_MMF_API_KEY=...
MARKIT_MMF_MODEL_ID=...
MARKIT_MODEL_MULTIMODAL=true
```

服务器部署推荐使用配置文件，不把 key 写进 repo：

```bash
cp config/mmf.config.example.json .markit/mmf.config.json
MARKIT_MMF_API_KEY=...
MARKIT_MMF_CONFIG=.markit/mmf.config.json
pnpm dev
```

`local-mms-mmf` 默认认为模型支持图片；如果临时只想走文本总结，设置 `MARKIT_MODEL_MULTIMODAL=false`。截图证据通过 JSON body 上传，默认 limit 为 `90mb`，可用 `MARKIT_JSON_LIMIT=120mb` 调整。

## Evidence

最新本地验收会输出：

- `.agent.local/evidence/tongzhang-er-final/e2e-result.json`
- `.agent.local/evidence/tongzhang-er-final/*.png`
- `.agent.local/evidence/public-url-smoke/result.json`
- `.agent.local/evidence/public-url-smoke/*.png`
- `.agent.local/evidence/catalog-snapshot-smoke/result.json`
- `.agent.local/evidence/catalog-snapshot-smoke/*.png`
- `.agent.local/evidence/macromoss-real/result.json`
- `.agent.local/evidence/macromoss-real/*.png`
- `.markit/exports/<bug-id>/bug.md`
- `.markit/exports/<bug-id>/bug.json`
- `.markit/exports/<bug-id>/captures/<capture-id>/screenshot.annotated.png`
- `.markit/exports/<bug-id>/captures/<capture-id>/crops/*.png`
