# atom-output-contract — Markit × requirement_atom.v1 对齐规范

版本：S3 / 2026-06-25  
共享契约脊柱：`outpact/.worktrees/s0-atom-contract/schemas/requirement-atom.schema.json`

---

## 一句话摘要

Markit 每次框选标注 → 一条 `requirement_atom.v1` atom。  
**Human 只需：框选 + 一句话 note + 选 P 级**；AI 预填 `assertion`，不要求人填全。

---

## 字段映射规范

| requirement_atom.v1 字段 | Markit 来源 | 说明 |
|---|---|---|
| `schema` | 硬编码 `"requirement_atom.v1"` | ledger 根字段 |
| `source_ref` | `"gl:<iid>"` 或 `"feishu:<recordId>"` | 顶层溯源，issue 提交后写入 |
| `atoms[].id` | `MKT-<bugId前8位>-<A01...>` | 稳定 id，ledger 内唯一 |
| `atoms[].source.kind` | 硬编码 `"markit-annotation"` | — |
| `atoms[].source.ref` | GitLab issue `iid`（`gl:<iid>`），提交前为 null | issue 提交后自动填写 |
| `atoms[].source.quote` | `annotation.note`（即人工一句话描述） | 人填的原文，C2：最低要求 |
| `atoms[].source.anchor.type` | `element` → element；`rect`/`ellipse`/`freehand` → rect；`pin` → pin；`section` → region | 非整页，修 Figma 锚整页病根 |
| `atoms[].source.anchor.value` | element: `target.selector`；rect/freehand/ellipse: `"x{x} y{y} w{w} h{h}"`；pin: 同 rect；region: `annotation.note \|\| bug.title` | NOT 整页字符串 |
| `atoms[].source.anchor.route` | `capture.finalUrl`（capture 对应页面 URL） | 域名 + route，不含查询串 |
| `atoms[].source.anchor.viewport` | `capture.viewport.isMobile ? "mobile" : "desktop"` | 视口类型 |
| `atoms[].intent` | `annotation.note \|\| bug.title` | 一句话 human 描述，REQUIRED |
| `atoms[].severity` | `bug.severity`（P0-P3） | 直传，不做转换 |
| `atoms[].assertion` | `null`（AI 预填后补，或 verify-time 写入） | capture 时可空，`status=pending` |
| `atoms[].evidence_required` | `false`（默认软，不阻塞 done） | 软闸，opt-in 可改硬 |
| `atoms[].status` | `"pending"`（初始） | GitLab/飞书 submit 后不自动改 |
| `atoms[].evidence_refs` | Feishu file tokens（`feishuSync.attachmentFileTokens`）或 GitLab 上传 URL | 附件指针，正文不进 ledger |

---

## Human 最小操作路径

```
框选区域（rect / element pick / section / pin）
  └─ 写一句话 note（annotation.note）
       └─ 选 P 级（bug.severity）
            └─ 保存 → 一条合法 atom
```

- **不要求人写 assertion / expected / reproSteps**：这些由 AI normalizer 预填或在 issue 创建时由 AI 补全。
- assertion 为 null、status=pending 即合法 atom；验收时 AI / QA 补填 verify/target/expected。
- element pick（`kind="element"`）时 target.selector 由 Playwright 自动提取，人不需要手写 selector。

---

## AI Evidence 附件写入契约（fldKBwIUX2）

飞书 Base app：`I7m2bnPDgaYnwksqp1jcmmW9nOd`，表：`tbl0yrCubWcpZCvw`，AI Evidence 字段：`fldKBwIUX2`

**写入路径（已实现）：**

```
exportBug()
  └─ submitGitLabIssues() → GitLab 上传 annotated screenshot / crops
       └─ maybeSyncFeishuIssue()
            └─ createFeishuRecord()  → 写文本字段（问题现象、链接、优先级…）
                 └─ maybeUploadFeishuAttachments()
                      └─ uploadFeishuAttachmentWithLarkCli()
                           └─ lark-cli base +record-upload-attachment
                                --base-token I7m2bnPDgaYnwksqp1jcmmW9nOd
                                --table-id tbl0yrCubWcpZCvw
                                --record-id <recordId>
                                --field-id fldKBwIUX2
                                --file ./screenshot.annotated.png
                                --as user --format json
```

**写入时机：**
- 在 `MARKIT_FEISHU_SYNC=1` 时，`issue-submit` 触发后自动上传 GitLab 已上传的本地截图证据。
- file tokens 保存在 `issueSubmission.feishuSync.attachmentFileTokens[]`。
- atom 的 `evidence_refs[]` 应引用这些 file token（格式：`feishu:<fileToken>`）或 GitLab asset URL。

**attachment 未写入的降级情形：**
- `MARKIT_FEISHU_SYNC` 未开启 → feishuSync=undefined → evidence_refs=[]（atom 仍合法，status=pending）
- lark-cli 权限问题 → `feishuSync.attachmentError` 有值 → evidence_refs=[] + 手动补全
- bot 无 Base 写权限 → 先用 `--as user`；等 bot 授权后切 `MARKIT_FEISHU_CLI_AS=bot`

---

## 映射函数（已实现）

`exportBug()` 现在在导出目录额外写入：

```
.markit/exports/<bugId>/requirement-atoms.json   ← requirement_atom.v1 ledger
```

与现有的 `bug.json`、`agent-packet.json`、`atomic-acceptance.md` 并存，不破坏现有结构。

函数：`requirementAtomLedgerFromDetail(detail, groups, captureMap)` — 见 `apps/server/src/routes/bugs.ts`。

---

## 真实样例

### 样例 1：element pick（自动抓取 selector）

**标注动作：** 在首页 `.price-tag` 元素上 element pick，note="价格字重应为 500 / 600，当前 400 偏细"，severity=P1

```json
{
  "id": "MKT-9bb5de9a-A01",
  "source": {
    "kind": "markit-annotation",
    "ref": "gl:42",
    "quote": "价格字重应为 500 / 600，当前 400 偏细",
    "anchor": {
      "type": "element",
      "value": "[data-testid='price-tag']",
      "route": "https://example.com/catalog",
      "viewport": "desktop"
    }
  },
  "intent": "价格字重应为 500 / 600，当前 400 偏细",
  "severity": "P1",
  "assertion": null,
  "evidence_required": false,
  "status": "pending",
  "evidence_refs": ["feishu:img_v3_00a1b2c3d4e5f6g7h8i9j0_abc123"]
}
```

AI 预填 assertion 后（在 issue / AI normalizer 阶段写入）：
```json
"assertion": {
  "verify": "playwright",
  "target": "[data-testid='price-tag']",
  "expected": "font-weight: 500 or 600"
}
```

### 样例 2：rect 框选（纯截图区域）

**标注动作：** 框选导航栏区域，note="移动端导航栏高度塌缩为 40px，应为 56px"，severity=P2

```json
{
  "id": "MKT-cfeb1d53-A01",
  "source": {
    "kind": "markit-annotation",
    "ref": null,
    "quote": "移动端导航栏高度塌缩为 40px，应为 56px",
    "anchor": {
      "type": "rect",
      "value": "x0 y0 w390 h40",
      "route": "https://example.com/",
      "viewport": "mobile"
    }
  },
  "intent": "移动端导航栏高度塌缩为 40px，应为 56px",
  "severity": "P2",
  "assertion": null,
  "evidence_required": false,
  "status": "pending",
  "evidence_refs": []
}
```

---

## 不变量（继承自共享契约）

- `source.anchor` 永不为整页，除非确实是页级要求（`type=page`）。  
  Markit 标注本质上都是局部区域，因此 element / rect / pin / region 四种均满足此约束。
- `assertion` 可空，但 `intent + anchor.value + severity` 永不可空。
- `evidence_refs` 仅存指针，正文证据体不进 ledger（aligns state-core）。
- `status=verified` 必须有 `evidence_refs`；`status=skipped` 必须有 `skip.reason`。
- 默认软闸（`evidence_required=false`）；硬闸需用户 opt-in。

---

## 三方消费关系

```
Markit 框选 → requirement-atoms.json（本 ledger）
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
work-gate         state-core       outpact
(checks[] ≡       (requirements_   (requirements[] 
 atoms[])          _verified slot)  spine 对齐)
```

- **work-gate / atomic-gate**：把每条 atom 的 `assertion.verify/target/expected` 作为 check spec 跑（playwright / visual-anchor-diff）。  
- **state-core**：`requirements_verified` slot 读 ledger；每条 `evidence_required=true` 的 atom 需有 `evidence_refs` 才 pass。  
- **outpact**：requirements[] 同样出 `requirement_atom.v1`；Markit ledger 可合并进同一 task ledger。

---

## 环境变量（Feishu 附件相关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARKIT_FEISHU_SYNC` | `0` | 1 开启飞书同步 |
| `MARKIT_FEISHU_ATTACHMENT_FIELD_ID` | `fldKBwIUX2` | AI Evidence 字段 ID |
| `MARKIT_FEISHU_BASE_TOKEN` | `I7m2bnPDgaYnwksqp1jcmmW9nOd` | Bitable app token |
| `MARKIT_FEISHU_TABLE_ID` | `tbl0yrCubWcpZCvw` | 问题表 table ID |
| `MARKIT_FEISHU_CLI_AS` | `user` | lark-cli 身份，`user` 或 `bot` |
| `MARKIT_FEISHU_AUTH` | `auto` | `auto`（token 优先）/ `lark-cli` / `token` |
