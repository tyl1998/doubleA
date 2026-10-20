# Linux 启动

## 前提

```bash
docker info >/dev/null && echo "docker OK"
node -v            # 需要 22 或以上（只在 IMAGE_SOURCE=build 时需要）
```

没有 Docker 时先装（以 Ubuntu/Debian 为例）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # 然后重新登录，或当前会话用 sudo
```

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
INSTANCE_IP=<本机内网 IP，如 10.73.100.153>
```

浏览器打开 `http://<INSTANCE_IP>:8080`。

## 基础服务已经在跑（最常见的情况）

`deploy.env` 默认 **`MANAGE_INFRA=0`**，即本包不会创建也不会停止 PG / Redis / MinIO，只连它们。
如果你的服务不在本机，填远端地址：

```ini
MANAGE_INFRA=0
REMOTE_PG_HOST=10.73.100.153
REMOTE_PG_PORT=15432
REMOTE_REDIS_HOST=10.73.100.153
REMOTE_REDIS_PORT=16379
REMOTE_S3_HOST=10.73.100.153
REMOTE_S3_PORT=19000
```

本机已有（用默认端口或改下面三项）：

```ini
POSTGRES_PORT=15432
REDIS_PORT=16379
MINIO_API_PORT=19000
```

## 从零开始（本包管理基础服务）

只有在**专用机器**上才这么做：

```ini
MANAGE_INFRA=1
```

脚本会创建 `doubulea-postgres` / `doubulea-redis` / `doubulea-minio`，卷名带 `doubulea-deploy-` 前缀，
不会和已有容器重名。

## 镜像

三选一，填在 `deploy.env`：

```ini
# A. 从仓库拉
IMAGE_SOURCE=registry
IMAGE_REGISTRY=registry.example.internal/doubulea

# B. 本地已 docker load
IMAGE_SOURCE=local

# C. 从源码构建（SRC_DIR 指向源码根，默认 ..）
IMAGE_SOURCE=build
```

## 只跑对话（不跑沙箱）

不需要 Docker socket 权限，最省事：

```ini
DOUBULEA_NODE_ROLE=chatbot
```

要跑 Code 模式 / taskAgent 时用默认的 `taskAgent`，并确认：

```bash
# socket 权限：一般留空让脚本自动探测；异常时手动指定容器视角的 gid
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock --entrypoint stat <任意本地镜像> -c '%g' /var/run/docker.sock
```

## 加一台机器（多机）

新机器上：

```ini
MODE=node
INSTANCE_ID=b
INSTANCE_IP=10.73.100.195
MANAGE_INFRA=0
NODE_OPS_SECRET=<与主节点同一份>
# 依赖服务指向主节点
REMOTE_PG_HOST=10.73.100.153
REMOTE_REDIS_HOST=10.73.100.153
REMOTE_S3_HOST=10.73.100.153
```

```bash
bash scripts/up.sh
```

主节点的网关会自动发现它（`ROUTER_DISCOVERY_SEC=10`）。在主节点验证：

```bash
curl -s --noproxy '*' http://127.0.0.1:13100/health
# discovery.discovered 里应出现 10.73.100.195:13000
```

## 日常命令

```bash
bash scripts/status.sh          # 状态总览
docker logs -f doubulea-backend # 后端日志
bash scripts/down.sh            # 停应用容器（基础服务不动）
bash scripts/up.sh --force      # 换了镜像后重建容器
```

## 出错先看这里

| 报错 | 处理 |
|---|---|
| `找不到 docker` | 装 Docker，并把账号加进 docker 组 |
| `配置不完整` | 4 个 ★ 没填 |
| `连不上 PG 127.0.0.1:15432` | 填 `REMOTE_PG_HOST`，或 `MANAGE_INFRA=1` |
| `port is already allocated` | 改 `BACKEND_PORT` / `GATEWAY_PORT` / `FRONTEND_PORT`，别停别人的容器 |
| 实例自检 `docker` 红 | 清空 `DOCKER_SOCKET_GID` 让脚本自动探测 |
| 迁移失败 | 看 `deploy/.generated/migrate.log` |
