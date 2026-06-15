# Lark Bug Workflow Analysis

日期：2026-06-15  
来源：`lark-cli` 只读查询，身份 `--as user`。

## 查到的来源

- `项目问题跟踪管理`：Wiki node `RE4XwG1rIi8PznkiEEfcX9Ftntc`，实际 Base token `I7m2bnPDgaYnwksqp1jcmmW9nOd`，表 `问题跟踪`。该表是审批/处理流模板，实际问题记录较少，字段偏流程：`项目`、`问题描述`、`问题附件`、`当前状态`、`要求处理人`、`处理结果`、`结果确认`。
- `4.0 需求列表& Bug记录 & 优化list`：Wiki node `ZpmNwEE7oi0I1skjd8dcq1fXnKb`，实际 Sheet token `PWOas6l3yhYxngto0QecqaAdnGg`，sheet `bug&优化`。读取 `A1:V194`，非空记录 162 条；本次分析取尾部近 100 条做字段/内容模式抽样。
- `5.0网站走查记录`：Wiki node `KjVhwO0TKiRoJlkCV1mcQmZ2nqc`，实际 Sheet token `AAAosoKkAh2wRHt4Ih3cwkGfnle`，sheet `bug`。读取 `A1:T200`，非空记录 8 条；全部纳入样本。

## 近 100 条 Bug/走查文本模式

抽样结果说明：4.0 sheet 取最近可读尾部 100 条，5.0 bug sheet 取 8 条，未读取附件二进制，只读取单元格结构与附件占位。

| 模式 | 4.0 近 100 条 | 5.0 8 条 | Markit 当前覆盖情况 |
| --- | ---: | ---: | --- |
| 有 URL/域名 | 12 | 8 | 已覆盖：真实 URL 输入、真实 Playwright 渲染、点击/滚动/输入、最终 URL 记录。 |
| 有截图/附件 | 97 | 8 | 已覆盖：截图、标注、裁剪、annotated screenshot、evidence export。缺：导入飞书原附件/对比图。 |
| 有状态 | 32 | 8 | 部分覆盖：Markit 有 status；需补成表格式筛选/批量查看。 |
| 有优先级 | 22 | 0 | 已覆盖：P0-P3；需补快捷键和 chips 降低填写成本。 |
| UI/样式类 | 29 | 7 | 已覆盖：元素/区块/框选/freehand；需补截图式椭圆圈选。 |
| 设计图/设计稿对比 | 5 | 0 | 缺口：需要 `需求链接` / `Figma或设计图链接` / 对比截图字段。 |
| Mobile/H5 | 8 | 2 | 已覆盖：mobile viewport；需保持双端可选而非默认。 |
| PC | 4 | 1 | 已覆盖：PC viewport。 |
| 点击/跳转/链接/按钮 | 8 | 0 | 已覆盖：browse mode 真实点击会触发真实跳转。 |
| 文案/文字/中文/标题 | 15 | 2 | 已覆盖：口语描述 + AI normalizer；需补 Bug 类型 chips。 |
| 布局错乱/显示不全/遮挡 | 9 | 5 | 已覆盖：rect/section/freehand；需补 ellipse 圈选。 |
| 广告展示 | 2 | 3 | 部分覆盖：可记录；后续可做专门 `广告异常` type。 |

## 对 Markit 的产品结论

- Markit 不能只做 UI 标注；要平替飞书 Bug 表格，最小字段应是：`title`、`severity`、`status`、`type`、`actual`、`expected`、`sourceUrl/finalUrl`、`requirementUrl`、`designUrl`、`annotations`、`evidence export`。
- 录入应该以选择为主：Bug 类型 chips、severity 快捷键、status dropdown、可选引用字段；默认只需要“口语描述 + 一个标注”。
- 标注工具需要两种“圈画”：`freehand` 是 OpenDesign 式自由画线；`ellipse` 是截图标注式一拖成圈，二者应并存。
- Bug list 应逐步变成表格/卡片混合：支持按状态、优先级、类型、URL/域名、更新时间筛选；当前卡片视图可先展示 type 和引用链接。
- 后续 Lark sink 应做字段映射，而不是把 Markit 绑死到某个 Base/Sheet：不同团队现有表结构差异很大。

## 执行命令摘录

```bash
lark-cli drive +search --as user --query "bug" --doc-types bitable --sort edit_time
lark-cli drive +search --as user --query "通胀二" --sort edit_time
lark-cli wiki +node-get --as user --node-token "https://adsconflux.feishu.cn/wiki/RE4XwG1rIi8PznkiEEfcX9Ftntc"
lark-cli base +table-list --as user --base-token I7m2bnPDgaYnwksqp1jcmmW9nOd
lark-cli base +field-list --as user --base-token I7m2bnPDgaYnwksqp1jcmmW9nOd --table-id tblst1jvn6EpJxkW
lark-cli sheets +read --as user --spreadsheet-token PWOas6l3yhYxngto0QecqaAdnGg --sheet-id 57b7a2 --range 'A1:V194'
lark-cli sheets +read --as user --spreadsheet-token AAAosoKkAh2wRHt4Ih3cwkGfnle --sheet-id VKIf4A --range 'A1:T200'
```

## 注意

- `lark-cli` 当前提示 binary `1.0.46`，skills `1.0.53`，建议后续空档执行 `lark-cli update` 同步。
- 本分析没有下载飞书附件图片，只分析了文字、链接、状态、优先级和附件占位结构。
