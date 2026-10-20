# Windows 启动

## 前提

1. **Docker Desktop**（Linux 容器模式），并已启动
2. 打开 **TCP 暴露**：Settings → General → 勾选
   **Expose daemon on `tcp://localhost:2375` without TLS**
   （Windows 上容器不能用 `/var/run/docker.sock`，后端要通过这个端口访问宿主 Docker）
3. PowerShell 中验证：

```powershell
docker info
docker run --rm alpine sh -c "nc -zv host.docker.internal 2375"
```

> ⚠️ 第 2 步只在开发机/内网机器上开。该端口等于暴露 Docker 控制面。
> 生产环境建议在 WSL2 里装原生 Docker Engine，然后按 `Linux.md` 走。

## 三步启动

```powershell
cd deploy
Copy-Item env\deploy.env.example deploy.env
notepad deploy.env
powershell -ExecutionPolicy Bypass -File scripts\up.ps1
```

要改的 4 项：

```ini
CREDENTIAL_MASTER_KEY=<openssl rand -base64 32 的输出，没有 openssl 就用下面的 node 命令>
POSTGRES_PASSWORD=<你的数据库密码>
S3_SECRET=<你的对象存储密钥>
INSTANCE_IP=127.0.0.1        # 只有本机访问；别的机器要访问就填内网 IP
```

生成密钥（没装 openssl 时）：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

浏览器打开 `http://127.0.0.1:8080`。

## 基础服务已经在跑

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

## 从零开始（本包管理基础服务）

```ini
MANAGE_INFRA=1
```

## 镜像

```ini
# A. 从仓库拉
IMAGE_SOURCE=registry
IMAGE_REGISTRY=registry.example.internal/doubulea

# B. 本地导入（推荐：公司内网常用）
IMAGE_SOURCE=local
```

导入镜像：

```powershell
Get-ChildItem *.tar | ForEach-Object { docker load -i $_.FullName }
```

> Windows 上 `IMAGE_SOURCE=build` **不支持**：镜像请在源码目录构建好再导入/推送。
> 构建需要 Node 22 + pnpm，且最好在 Linux/macOS 上做（沙箱镜像构建依赖 Linux 工具链）。

## 工作区目录

默认 `%USERPROFILE%\doubulea\workspaces`，脚本会自动创建。要换位置：

```ini
WORKSPACE_ROOT=D:\doubulea\workspaces
```

必须是 **Windows 绝对路径**（带盘符）。

## 只跑对话（不跑沙箱）

```ini
DOUBULEA_NODE_ROLE=chatbot
```

这条不需要 2375 端口，也不需要沙箱镜像。

## Windows 与 Linux/macOS 的差异（脚本已处理）

| 项 | Linux / macOS | Windows |
|---|---|---|
| 后端网络 | `--network host` | `-p 13000:13000 -p 13001:13001` |
| 访问宿主 Docker | 挂 `/var/run/docker.sock` | `DOCKER_HOST=tcp://host.docker.internal:2375` |
| socket 组 id | 需要 | 不需要 |
| 沙箱回调 | listener 直连 | 经 `doubulea-sandbox-relay` |

这些都在 `scripts\up.ps1` 里固定好了，不用你改。

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 后端日志 `connect ECONNREFUSED ...:2375` | Docker Desktop 没开 TCP 暴露 | 按前提第 2 步打开，重启 Docker Desktop |
| 实例自检 `docker` / `relay` 红 | relay 没起来，或 2375 不通 | `docker logs doubulea-sandbox-relay`；先验证 `nc -zv host.docker.internal 2375` |
| PowerShell 报语法错 / 中文乱码 | 用编辑器把脚本存成了带 BOM 或改了编码 | `scripts\*.ps1` **保持 ASCII**，不要往里面加中文 |
| `ExecutionPolicy` 拒绝执行 | Windows 默认策略 | 命令里带 `-ExecutionPolicy Bypass` |
| 端口冲突 | 13000/13100/8080 被占 | 改 `deploy.env` 的端口 |

## 日常命令

```powershell
powershell -ExecutionPolicy Bypass -File scripts\up.ps1
powershell -ExecutionPolicy Bypass -File scripts\up.ps1 -Force
powershell -ExecutionPolicy Bypass -File scripts\down.ps1
docker logs -f doubulea-backend
```

> 验证状态目前只有 bash 版的 `status.sh`。Windows 上用
> `docker ps --filter name=doubulea` 或直接看 `http://127.0.0.1:13000/health`。
