# Markit 生产部署 & 运维手册

Date: 2026-06-25
Server: 10.153.48.26
OS: Rocky Linux 9.6
Domain: markit.adsconflux.xyz (HTTPS 由 STGW 终止)
Port: 8866 (内网 nginx)

## 0. 部署链路总览

```text
你的本地机器
  │  修改代码 → pnpm build (本地验证)
  │  git commit && git push origin main
  ▼
GitHub (github.com:CtriXin/markit.git)
  │
  ▼
JumpServer (堡垒机, expect + oathtool OTP)
  │  通过 company-jump-run.py 脚本连接
  ▼
生产服务器 (10.153.48.26, 主机名 VM-48-26-rockylinux)
  │  git pull origin main
  │  pnpm install --frozen-lockfile
  │  pnpm build
  │  systemctl restart markit
  ▼
nginx (:8866) → 用户通过 STGW HTTPS 或内网 HTTP 访问
```

关键：本地不需要直接 SSH 到服务器。通过 JumpServer 间接执行命令。

## 1. 架构概览

```text
用户 → https://markit.adsconflux.xyz (STGW SSL 终止)
      → STGW 转发到后端 10.153.48.26:8866
      → nginx (:8866)
          ├─ /api/* → proxy_pass http://127.0.0.1:4317 (Node.js Express)
          └─ /*     → 静态文件 (/opt/markit/app/apps/web/dist)
```

关键端口：
- 8866: nginx 对外端口（STGW 或直接 HTTP 访问）
- 4317: Node.js API server（只监听 127.0.0.1，不对外暴露）

## 2. 从本地部署到线上（完整流程）

前置条件：

- 代码已提交并推送到 GitHub (`git push origin main`)
- 本机有 JumpServer 访问工具（`oracle-server/scripts/company-jump-run.py`）
- JumpServer 密钥在 `oracle-server/secrets/jump-and-vpn.local.md`

### 3.1 一键部署

```bash
cd /path/to/oracle-server
python3 scripts/company-jump-run.py persona "
  cd /opt/markit/app &&
  git pull origin main &&
  pnpm install --frozen-lockfile &&
  pnpm build &&
  systemctl restart markit &&
  sleep 2 &&
  curl -s http://127.0.0.1:4317/api/health
"
```

`persona` 是 JumpServer 上 10.153.48.26 对应的目标名称（markit 和 persona 同机）。

### 3.2 分步操作

如果一键部署失败，可以分步排查：

```bash
# 1. 连接服务器，发送单个命令
python3 scripts/company-jump-run.py persona "hostname"

# 2. 拉取代码
python3 scripts/company-jump-run.py persona "cd /opt/markit/app && git pull origin main"

# 3. 如果服务器有本地改动导致 pull 失败，先 stash
python3 scripts/company-jump-run.py persona "cd /opt/markit/app && git stash && git pull --ff-only origin main"

# 4. 安装依赖和构建
python3 scripts/company-jump-run.py persona "cd /opt/markit/app && pnpm install --frozen-lockfile && pnpm build"

# 5. 重启服务
python3 scripts/company-jump-run.py persona "systemctl restart markit"

# 6. 验证
python3 scripts/company-jump-run.py persona "curl -s http://127.0.0.1:4317/api/health"
```

### 3.3 本地代码 → 服务器流程图

```
本地开发
  │ 修改 apps/web/src/App.tsx 或 apps/server/src/
  │ pnpm build (检查是否能编译通过)
  │ git commit + git push origin main
  ▼
GitHub 已包含最新代码
  │
  ▼
通过 JumpServer 发送部署命令
  │ python3 scripts/company-jump-run.py persona "..."
  │
  ▼
服务器执行：
  │ git pull origin main    ← 拉取最新代码
  │ pnpm install             ← 同步依赖
  │ pnpm build               ← 编译 web + server
  │ systemctl restart markit ← 重启服务
  │ curl .../api/health      ← 验证
  ▼
线上更新完成
```

### 3.4 如果服务器 Git 仓库没有 SSH key

服务器上 `/opt/markit/app` 如果 clone 时用了 SSH 但没配 key，会 pull 失败。此时：

```bash
# 把远程改成 HTTPS（不需要配 key）
python3 scripts/company-jump-run.py persona "cd /opt/markit/app && git remote set-url origin https://github.com/CtriXin/markit.git"
```

### 3.5 JumpServer 工具说明

`company-jump-run.py` 是一个 expect 脚本自动化工具：

- 用 oathtool（TOTP）生成一次性密码
- 自动登录 JumpServer 菜单并选择目标
- 把命令 base64 编码后传过去执行
- 返回执行结果和退出码

支持的 JumpServer 目标：
- `persona` — 10.153.48.26（markit 所在服务器）
- `crs`, `new`, `libre` — 其他服务器

密钥存在 `oracle-server/secrets/jump-and-vpn.local.md`：
- host / port / user / password
- OTP seed（TOTP 密钥）

如果 `oathtool` 未安装：

```bash
brew install oath-toolkit        # macOS
dnf install oath-toolkit         # Linux
```

## 3. 服务器目录结构
├── app/                   # 代码仓库（git clone）
│   ├── apps/
│   │   ├── server/        # Express API
│   │   └── web/           # React SPA (Vite)
│   ├── packages/
│   │   └── ai-normalizer/ # AI 描述整理模块
│   └── pnpm-workspace.yaml
├── ptc-wiki/              # 项目 catalog（git clone）
│   ├── integrations/markit.json
│   ├── catalog/catalog.manifest.json
│   ├── catalog/domains.json
│   └── catalog/projects/*.json
├── update.sh              # 一键更新脚本
└── build.log              # 最近构建日志
```

数据目录：
```
/var/lib/markit/
├── markit.db              # SQLite 数据库（sessions, captures, bugs, annotations）
└── captures/              # 截图文件
    └── cap_<uuid>/
        ├── screenshot.png
        └── dom-targets.json
```

## 4. 环境变量

配置文件: `/etc/markit/markit.env`

```ini
NODE_ENV=production
MARKIT_SERVER_PORT=4317
MARKIT_WEB_ORIGIN=http://10.153.48.26:8866
MARKIT_JSON_LIMIT=90mb
MARKIT_DATA_DIR=/var/lib/markit
MARKIT_CATALOG_ROOT=/opt/markit/ptc-wiki

MARKIT_GITLAB_BASE_URL=https://gitlab.adsconflux.xyz
MARKIT_GITLAB_AUTH=token
MARKIT_GITLAB_TOKEN=glpat-xxx

MARKIT_AI_PROVIDER=openai-compatible
MARKIT_MODEL_BASE_URL=http://10.153.22.17/openapi/v1
MARKIT_MODEL_API_KEY=na_xxx
MARKIT_MODEL_ID=qwen3.5-plus
MARKIT_MODEL_MULTIMODAL=true

# Optional: GitLab issue created -> Feishu Base sync.
# 2026-06-25: keep disabled until Feishu app approval + server user auth pass.
MARKIT_FEISHU_SYNC=0
MARKIT_FEISHU_AUTH=auto
MARKIT_FEISHU_BASE_URL=https://open.feishu.cn
MARKIT_FEISHU_BASE_TOKEN=I7m2bnPDgaYnwksqp1jcmmW9nOd
MARKIT_FEISHU_TABLE_ID=tbl0yrCubWcpZCvw
MARKIT_FEISHU_ATTACHMENT_FIELD_ID=fldKBwIUX2
MARKIT_FEISHU_OWNER_OPEN_IDS=ou_30c6391467af3f8ffb00e07bac50b368
MARKIT_FEISHU_CLI_AS=user
```

### Env 字段说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `MARKIT_SERVER_PORT` | 否 | API 监听端口，默认 4317 |
| `MARKIT_WEB_ORIGIN` | 是 | nginx 的访问地址，用于 CORS |
| `MARKIT_DATA_DIR` | 否 | 数据目录，默认 `.markit/` |
| `MARKIT_CATALOG_ROOT` | 否 | ptc-wiki 路径，不设置时 catalog 功能禁用 |
| `MARKIT_GITLAB_BASE_URL` | 是 | GitLab 地址 |
| `MARKIT_GITLAB_AUTH` | 否 | `token` 或 `auto` |
| `MARKIT_GITLAB_TOKEN` | 条件是 | `MARKIT_GITLAB_AUTH=token` 时必须 |
| `MARKIT_AI_PROVIDER` | 否 | `off` / `mock` / `openai-compatible` / `local-mms-mmf` |
| `MARKIT_MODEL_BASE_URL` | 条件是 | `openai-compatible` 时 |
| `MARKIT_MODEL_API_KEY` | 条件是 | `openai-compatible` 时 |
| `MARKIT_MODEL_ID` | 否 | 模型 ID，默认 `qwen3.5-plus` |
| `MARKIT_MODEL_MULTIMODAL` | 否 | 是否支持图片输入 |
| `MARKIT_FEISHU_SYNC` | 否 | `1` 时 GitLab Work Item 创建成功后同步飞书 Base |
| `MARKIT_FEISHU_AUTH` | 否 | `auto` / `token` / `lark-cli`，服务器当前推荐 `auto` + `lark-cli --as user` |
| `MARKIT_FEISHU_BASE_TOKEN` | 条件是 | 飞书 Base app token，默认当前问题表 |
| `MARKIT_FEISHU_TABLE_ID` | 条件是 | 飞书 Base table ID |
| `MARKIT_FEISHU_ATTACHMENT_FIELD_ID` | 条件是 | 飞书附件字段 ID |
| `MARKIT_FEISHU_OWNER_OPEN_IDS` | 否 | 飞书 user 字段 open_id；宋鑫是 `ou_30c6391467af3f8ffb00e07bac50b368` |
| `MARKIT_FEISHU_CLI_AS` | 否 | `user` 或 `bot`；bot 写 Base 前必须先确认权限已通过 |

## 5. 服务管理

```bash
# 状态检查
systemctl status markit
journalctl -u markit -n 50 --no-pager

# 启停
systemctl restart markit
systemctl stop markit
systemctl start markit

# 查看实时日志
journalctl -u markit -f
```

### nginx

```bash
# 配置位置
/etc/nginx/conf.d/markit.conf

# 检查和重载
nginx -t
systemctl reload nginx
```

### 健康检查

```bash
# nginx 到 API 全链路
curl http://10.153.48.26:8866/api/health
# 预期: {"ok":true,"name":"markit-server","version":"0.1.0","time":"..."}

# API 直接检查
curl http://127.0.0.1:4317/api/health

# 验证 domain Host header
curl -sI -H "Host: markit.adsconflux.xyz" http://10.153.48.26:8866/
# 预期: 200 OK
```

## 6. 服务器上手动更新

### 一键更新

```bash
bash /opt/markit/update.sh
```

### 手动步骤

```bash
# 1. 拉代码
cd /opt/markit/app
git pull origin main

# 2. 安装依赖（--frozen-lockfile 确保 lock 一致）
pnpm install --frozen-lockfile

# 3. 构建
pnpm build

# 4. 重启服务
systemctl restart markit

# 5. 验证
sleep 2 && curl -s http://127.0.0.1:4317/api/health
curl -s http://10.153.48.26:8866/api/health
```

### 更新 ptc-wiki catalog

Markit 生产环境从 `/opt/markit/ptc-wiki` 读取项目/域名 catalog。这个仓库在 GitLab：`ptc/fe/ptc-wiki`。

2026-06-25 实测注意点：

- 服务器上 `/opt/markit/ptc-wiki` 的 remote 可能是 `git@gitlab.adsconflux.xyz:ptc/fe/ptc-wiki.git`；如果服务器没有 SSH key，普通 `git pull` 会卡在 publickey。
- 服务器 `/etc/markit/markit.env` 已有 `MARKIT_GITLAB_TOKEN`，可以用临时 `GIT_ASKPASS` 做 HTTPS pull，不要把 token 写入 remote URL。
- 如果从 macOS 拷贝过仓库，可能出现 `._*` AppleDouble 资源叉文件；它们会让 git status 很脏，必要时清理。

```bash
cd /path/to/oracle-server
python3 scripts/company-jump-run.py persona "
  set -a
  . /etc/markit/markit.env
  set +a
  cat > /tmp/markit-git-askpass.sh <<'EOF'
#!/bin/sh
case \"\$1\" in
  *Username*) printf '%s\n' oauth2 ;;
  *) printf '%s\n' \"\$MARKIT_GITLAB_TOKEN\" ;;
esac
EOF
  chmod 700 /tmp/markit-git-askpass.sh
  cd /opt/markit/ptc-wiki &&
  find . -name '._*' -type f -delete &&
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/tmp/markit-git-askpass.sh \
    git -c safe.directory=/opt/markit/ptc-wiki \
    pull --ff-only https://gitlab.adsconflux.xyz/ptc/fe/ptc-wiki.git main
  rc=\$?
  rm -f /tmp/markit-git-askpass.sh
  exit \$rc
"
```

更新后验证：

```bash
python3 scripts/company-jump-run.py persona \
  "curl -s 'http://127.0.0.1:4317/api/catalog/resolve?url=https%3A%2F%2Fquizhew.com%2F' | head -c 1200"
```

2026-06-25 实测 `quizhew.com` 已解析为 `情感测试三 / ptc-ai-emotion`，catalog 计数为 `projectCount=166`、`domainCount=837`。

### update.sh 内容

```bash
#!/bin/bash
set -e
cd /opt/markit/app
git pull origin main
pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm build 2>&1 | tail -5
systemctl restart markit
sleep 2
curl -s http://127.0.0.1:4317/api/health
```

## 7. 初始部署（新机器）

如果需要在另一台服务器上全新部署：

### 7.1 系统依赖

```bash
# Rocky Linux / CentOS
dnf install -y nginx atk cups-libs libdrm mesa-libgbm pango gtk3 libXScrnSaver

# Node.js v24+（使用 nvm 或 binary）
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
dnf install -y nodejs

# pnpm
corepack enable && corepack prepare pnpm@latest --activate
```

### 7.2 克隆代码

```bash
mkdir -p /opt/markit
cd /opt/markit

# 主仓库
git clone git@github.com:CtriXin/markit.git app

# ptc-wiki catalog
git clone git@gitlab.adsconflux.xyz:ptc/fe/ptc-wiki.git ptc-wiki
```

### 7.3 安装 Playwright 和 Chromium

```bash
cd /opt/markit/app
pnpm install --frozen-lockfile
npx playwright install chromium
# Rocky Linux 不支持 --with-deps，需手动安装缺失库
ldd /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep "not found"
dnf install -y <缺失的库>
```

### 7.4 nginx 配置

`/etc/nginx/conf.d/markit.conf`：

```nginx
server {
    listen 0.0.0.0:8866;
    server_name _;

    # 静态资源启用 gzip
    gzip on;
    gzip_types text/css application/javascript image/svg+xml;
    gzip_min_length 1000;

    root /opt/markit/app/apps/web/dist;
    index index.html;
    try_files $uri $uri/ /index.html;

    location /api/ {
        # API 路径不要 gzip（会破坏 SSE）
        gzip off;
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100m;
    }
}
```

### 7.5 systemd 服务

`/etc/systemd/system/markit.service`：

```ini
[Unit]
Description=Markit URL annotation & bug capture tool
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/markit/app
EnvironmentFile=/etc/markit/markit.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now markit
```

### 7.6 环境配置文件

`/etc/markit/markit.env` — 参见第 4 节。

## 8. 服务访问入口

### STGW（腾讯云 CLB）

当前架构：STGW 对外提供 HTTPS（`markit.adsconflux.xyz:443`），SSL 在 STGW 终止，然后转发到后端 `10.153.48.26:8866`。

**如果 STGW 返回 502：**
1. 确认 nginx 正常运行：`systemctl status nginx`
2. 确认 8866 端口可访问：`curl http://10.153.48.26:8866/`
3. 确认 Host header 不影响本机 nginx：`curl -sI -H "Host: markit.adsconflux.xyz" http://10.153.48.26:8866/`
4. 找运维检查 STGW 后端池配置：
   - 后端地址是否为 `10.153.48.26:8866`
   - 健康检查路径/端口是否配置正确

2026-06-25 实测：

- `http://10.153.48.26:8866/` 返回 `200 OK`
- `http://10.153.48.26:8866/api/health` 返回 `ok:true`
- `Host: markit.adsconflux.xyz` 直打 `10.153.48.26:8866` 返回 `200 OK`
- `https://markit.adsconflux.xyz` 仍返回 STGW `502`

因此这类 502 优先判断为 STGW 到后端池的转发/健康检查问题，不是 Markit systemd 或 nginx 本体问题。

### 直连（内网 HTTP）

```bash
curl http://10.153.48.26:8866/
```

## 9. 日志排查

```bash
# API 服务日志
journalctl -u markit -n 100 --no-pager

# 实时跟踪
journalctl -u markit -f

# nginx 访问日志
tail -f /var/log/nginx/markit-access.log
tail -f /var/log/nginx/error.log

# 服务启动失败时查看完整日志
journalctl -u markit --since "5 minutes ago"
```

## 10. 常见问题

### 10.1 前端崩溃

原因：`deviceSlots` 中某个 slot 的 `session` 字段为 undefined，但代码直接访问 `.session.id`。

修复：已在 `apps/web/src/App.tsx` 中所有访问点加上 optional chaining（`slot.session?.id`）。部署最新代码后应该解决。

### 10.2 Screencast 卡顿

参数在 `apps/server/src/routes/sessions.ts:217`：

```typescript
// 当前配置（已优化）
await client.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 3 });
```

- `quality` 越低帧越小（范围 0-100）
- `everyNthFrame` 越大跳帧越多（减少帧率）
- 如果服务器 CPU 或网络带宽紧张，可以进一步提高 `everyNthFrame`

### 10.3 Playwright Chromium 缺失

```bash
# 检查安装
ls /root/.cache/ms-playwright/

# 重装
cd /opt/markit/app
npx playwright install chromium
```

Rocky Linux 上 `--with-deps` 不可用，需要手动 `dnf` 安装缺失库。

### 10.4 GitLab API 401

检查 token 是否有效：

```bash
curl -H "PRIVATE-TOKEN: <token>" https://gitlab.adsconflux.xyz/api/v4/user
```

如果 token 过期，在 GitLab → Settings → Access Tokens 重新生成。

### 10.5 Feishu sync 卡住

当前 Feishu sync 有两层权限：

1. 飞书开发者后台 app scopes：服务器 app `cli_aaa08cdcb9b95bcb` 必须申请 `base:app:read`、`base:table:read`、`base:field:read`、`base:record:create`、`base:record:read`、`base:record:update`、`drive:file:upload`、`auth:user.id:read`、`offline_access`。
2. 服务器 user auth：scope 审批通过后，在服务器上跑 `lark-cli auth login --domain base --domain drive --scope 'auth:user.id:read offline_access' --no-wait --json`，把链接给宋鑫授权，再用 `lark-cli auth login --device-code <device_code>` 完成登录。

2026-06-25 审批未通过前的实测状态：

- `lark-cli auth status`：bot ready，user missing。
- `lark-cli base +base-get --as bot`：返回 `app_scope_not_applied`，缺 `base:app:read`。
- 生产 `/etc/markit/markit.env` 暂未开启 `MARKIT_FEISHU_SYNC=1`，避免测试同学创建 issue 时反复看到 Feishu 失败。

审批通过后再开启：

```ini
MARKIT_FEISHU_SYNC=1
MARKIT_FEISHU_AUTH=auto
MARKIT_FEISHU_CLI_AS=user
```

## 11. 关键 API 端点

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/sessions` | 会话列表 |
| `POST /api/sessions` | 创建新会话（打开 URL） |
| `GET /api/sessions/:id/captures` | 会话的截图列表 |
| `GET /api/captures/:id/image` | 截图图片 |
| `GET /api/catalog/status` | Catalog 状态 |
| `GET /api/ai/status` | AI 连接状态 |
