# agent-soul-company-auth Reuse Notes For Markit

日期：2026-06-15  
只读检查路径：`/Users/xin/auto-skills/CtriXin-repo/agent-soul-company-auth`

## 可复用但不应直接耦合的能力

- LDAP login：`src/ldap-auth.ts` 已有 LDAP bind、user search、allowlist、NewAPI persona key sync。Markit 后续 team mode 可以借鉴这条登录层，但 MVP 不应直接引入 agent-soul auth runtime。
- NewAPI/OpenAI-compatible route：`src/newapi.ts` 能把公司 NewAPI model catalog/route 转成 OpenAI-like provider。Markit 当前 `MARKIT_AI_PROVIDER=openai-compatible` 可以后续做 adapter，对接 MMF/MMS 或 NewAPI，而不是复制 agent-soul provider 栈。
- Browser session/task model：`src/browser-session-store.ts` 与 `src/server-browser-sessions.ts` 提供 task/session/action/evidence/human-gate 的结构。Markit 的 Playwright session 已经更贴近“真实截图标注”，可以只借鉴 evidence/event/action 命名。
- Auth provider boundary：`docs/134-browser-agent-p114-auth-session-boundary.md`、`docs/140-browser-agent-p120-auth-provider-contract.md` 明确 cookie/header/storage 不自动读取，auth values 走用户或 external provider runtime slot。Markit 如果支持登录态复用，应沿用这个边界。
- Canvas 思路：`docs/15-canvas-mvp-notes.md` 的“选择 / 加入参考 / 本地编辑区域 / references 明确化”适合 Markit 的对比截图与设计稿引用，但 Markit 不需要搬 Konva canvas。

## 对 Markit 的落地建议

- 近期：保留本地 Playwright session，不引入 agent-soul server；只补 `requirementUrl`、`designUrl`、evidence references、quick chips、ellipse 圈选。
- 中期：做 `auth provider adapter`，例如用户显式提供 LDAP/测试账号或外部 lookup 脚本输出一次性登录参数；Markit 不直接读取用户浏览器 cookie。
- 中期：做 `model provider adapter`，把 Markit AI normalizer 的 OpenAI-compatible 配置映射到 MMF/MMS/NewAPI route。
- 中期：做 `issue sink adapter`，支持导出到 Lark Base/Sheet，但字段 mapping 独立配置，不绑定某一个飞书表结构。
- 不建议：把 agent-soul browser-agent runtime 直接搬进 Markit。Markit 的核心是截图标注与 bug evidence；agent-soul 的核心是 agent task/human-gate/control-plane。
