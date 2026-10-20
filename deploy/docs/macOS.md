# macOS 启动

## 前提

任选一个 Docker 运行时（都要先启动起来）：

- **OrbStack**（推荐，比 Docker Desktop 快）
- Docker Desktop

```bash
docker info >/dev/null && echo "docker OK"
```

> macOS 上没有原生 Linux 内核，Docker 跑在一个轻量 VM 里。部署脚本已经处理了由此带来的差异
> （沙箱回调走 `sandbox-relay`），你不需要额外配置。

## 三步启动

```bash
cd deploy
cp env/deploy.env.example deploy.env
vi deploy.env        # 改 4 个 ★ 项
bash scripts/up.sh
```

要改的 4 项：

```ini
CREDENTIAL_MASTER_KEY=<openssl rand -base64 32 的输出>
POSTGRES_PASSWORD=<你的数据库密码>
S3_SECRET=<你的对象存储密钥>
INSTANCE_IP=127.0.0.1        # 只有本机访问；别的机器要访问就填内网 IP
```

浏览器打开 `http://127.0.0.1:8080`。

## 基础服务已经在跑（最常见的情况）

默认 **`MANAGE_INFRA=0`**：不创建也不停止 PG / Redis / MinIO。

```ini
MANAGE_INFRA=0
REMOTE_PG_HOST=127.0.0.1
REMOTE_PG_PORT=15432
REMOTE_REDIS_HOST=127.0.0.1
REMOTE_REDIS_PORT=16379
REMOTE_S3_HOST=127.0.0.1
REMOTE_S3_PORT=19000
```

> 端口是 `infra/.env` 里的值（本机习惯把 5432/6379/9000 后移到 1xxxx，避免和别的项目冲突）。
> 用 `docker ps` 确认。

## 从零开始（本包管理基础服务）

```ini
MANAGE_INFRA=1
```

## 镜像

```ini
# A. 从仓库拉
IMAGE_SOURCE=registry
IMAGE_REGISTRY=ghcr.io/tyl1998

# B. 本地已有
IMAGE_SOURCE=local

# C. 从源码构建
IMAGE_SOURCE=build
```

> ⚠️ **架构**：Apple Silicon（M 系列）构建出来的镜像是 `linux/arm64`，拷到 amd64 的 Linux 机器上会
> `exec format error`。跨机分发时要么在同架构机器上构建，要么用
> `docker buildx build --platform linux/amd64`。

## 工作区目录

默认 `~/doubulea/workspaces`，脚本会自动创建并放权。要换位置：

```ini
WORKSPACE_ROOT=/Users/you/data/doubulea-workspaces
```

> macOS 的 bind mount 走 VM 文件共享，工作区里文件很多时 IO 会比 Linux 慢。介意的话把工作区放在
> 磁盘上 IO 较好的位置，或用 OrbStack 的 VirtioFS 设置。

## 只跑对话（不跑沙箱）

```ini
DOUBULEA_NODE_ROLE=chatbot
```

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 实例自检 `docker` 红 / 后端日志 `permission denied ... docker.sock` | socket gid 取错（OrbStack 宿主 `stat` 是 `1`，容器内实际是 `0`） | 清空 `DOCKER_SOCKET_GID` 让脚本自动探测；已默认如此 |
| 网关一直 502 | 上游写成了 `127.0.0.1`（网关容器里的回环是它自己） | 单机时脚本自动用 `host.docker.internal`，不要手改 |
| 端口冲突 | 13000/13100/8080 被别的项目占用 | 改 `BACKEND_PORT` / `GATEWAY_PORT` / `FRONTEND_PORT` |
| 构建卡在 `npm install` 很久没输出 | 容器直连 npmjs 被拦（apt 却正常，容易误判） | `SANDBOX_NPM_REGISTRY=https://registry.npmmirror.com` 后重建沙箱镜像 |
| 从源码构建报 `docker-credential-osxkeychain ... not found` | 非交互 shell 找不到凭据助手 | 用 `pnpm backend:build-image` 等脚本，别手敲 `docker build` |

## 日常命令

```bash
bash scripts/status.sh           # 状态总览
docker logs -f doubulea-backend  # 后端日志
bash scripts/down.sh             # 停应用容器（基础服务不动）
bash scripts/up.sh --force       # 换了镜像后重建
```
