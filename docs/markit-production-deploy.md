# Markit 生产部署 & 运维手册

Date: 2026-06-25
Server: 10.153.48.26
OS: Rocky Linux 9.6
Domain: markit.adsconflux.xyz (HTTPS 由 STGW 终止)
Port: 8866 (内网 nginx)

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

## 2. 服务器目录结构

```
/opt/markit/
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

## 3. 环境变量

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

## 4. 服务管理

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

## 5. 部署更新

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

## 6. 初始部署（新机器）

如果需要在另一台服务器上全新部署：

### 6.1 系统依赖

```bash
# Rocky Linux / CentOS
dnf install -y nginx atk cups-libs libdrm mesa-libgbm pango gtk3 libXScrnSaver

# Node.js v24+（使用 nvm 或 binary）
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
dnf install -y nodejs

# pnpm
corepack enable && corepack prepare pnpm@latest --activate
```

### 6.2 克隆代码

```bash
mkdir -p /opt/markit
cd /opt/markit

# 主仓库
git clone git@github.com:CtriXin/markit.git app

# ptc-wiki catalog
git clone git@gitlab.adsconflux.xyz:ptc/ptc-wiki.git ptc-wiki
```

### 6.3 安装 Playwright 和 Chromium

```bash
cd /opt/markit/app
pnpm install --frozen-lockfile
npx playwright install chromium
# Rocky Linux 不支持 --with-deps，需手动安装缺失库
ldd /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep "not found"
dnf install -y <缺失的库>
```

### 6.4 nginx 配置

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

### 6.5 systemd 服务

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

### 6.6 环境配置文件

`/etc/markit/markit.env` — 参见第 3 节。

## 7. 服务访问入口

### STGW（腾讯云 CLB）

当前架构：STGW 对外提供 HTTPS（`markit.adsconflux.xyz:443`），SSL 在 STGW 终止，然后转发到后端 `10.153.48.26:8866`。

**如果 STGW 返回 502：**
1. 确认 nginx 正常运行：`systemctl status nginx`
2. 确认 8866 端口可访问：`curl http://10.153.48.26:8866/`
3. 找运维检查 STGW 后端池配置：
   - 后端地址是否为 `10.153.48.26:8866`
   - 健康检查路径/端口是否配置正确

### 直连（内网 HTTP）

```bash
curl http://10.153.48.26:8866/
```

## 8. 日志排查

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

## 9. 常见问题

### 9.1 前端崩溃 "Cannot read properties of undefined (reading 'id')"

原因：`deviceSlots` 中某个 slot 的 `session` 字段为 undefined，但代码直接访问 `.session.id`。

修复：已在 `apps/web/src/App.tsx` 中所有访问点加上 optional chaining（`slot.session?.id`）。部署最新代码后应该解决。

### 9.2 Screencast 卡顿

参数在 `apps/server/src/routes/sessions.ts:217`：

```typescript
// 当前配置（已优化）
await client.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 3 });
```

- `quality` 越低帧越小（范围 0-100）
- `everyNthFrame` 越大跳帧越多（减少帧率）
- 如果服务器 CPU 或网络带宽紧张，可以进一步提高 `everyNthFrame`

### 9.3 Playwright Chromium 缺失

```bash
# 检查安装
ls /root/.cache/ms-playwright/

# 重装
cd /opt/markit/app
npx playwright install chromium
```

Rocky Linux 上 `--with-deps` 不可用，需要手动 `dnf` 安装缺失库。

### 9.4 GitLab API 401

检查 token 是否有效：

```bash
curl -H "PRIVATE-TOKEN: <token>" https://gitlab.adsconflux.xyz/api/v4/user
```

如果 token 过期，在 GitLab → Settings → Access Tokens 重新生成。

## 10. 关键 API 端点

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/sessions` | 会话列表 |
| `POST /api/sessions` | 创建新会话（打开 URL） |
| `GET /api/sessions/:id/captures` | 会话的截图列表 |
| `GET /api/captures/:id/image` | 截图图片 |
| `GET /api/catalog/status` | Catalog 状态 |
| `GET /api/ai/status` | AI 连接状态 |
