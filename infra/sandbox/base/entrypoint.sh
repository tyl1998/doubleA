#!/usr/bin/env bash
# =====================================================================
# entrypoint.sh — 把**只读层里的 pi 配置**种到可写区，再把控制权交给 pi（P0-3-1）
#
# 【为什么必须有这一步 —— 构建期实测出来的，不是设计推演】
#   base 层原先把 `PI_CODING_AGENT_DIR` 直接指向只读的种子目录（`/opt/pi/agent`，
#   root 属主、agent 不可写）。镜像构建时跑 `pi --help` 拿到：
#
#     Warning: Invalid settings file /opt/pi/agent/settings.json:
#              EACCES: permission denied, mkdir '/opt/pi/agent/settings.json.lock'
#
#   ⇒ 两件事同时成立：① pi **读** settings.json 时会先在同目录加一把锁（`settings.json.lock`）；
#      ② 加不上锁时它把整个 settings.json 判成 **invalid 并忽略**（不是"跳过这一项"）。
#   后果是**静默**的：`sessionDir` / `defaultProjectTrust` / `enableInstallTelemetry` 三个键
#   全部不生效 —— 表现会变成"会话写到只读的 agent-dir 里失败""headless 弹信任提示"，
#   而排查方向完全指不到这里。（顺带一条教训：base 层那句 `pi --help > /dev/null`
#   把这条警告**吞掉了**，是在 toolkit 自检里复现才看见的。）
#
#   ⚠️ 因此"配置放只读层"这条（`子方案③` §五 1）的正确落法是**两步**：
#     **只读的种子 + 运行期种到可写区**，而不是"直接把 agent-dir 指到只读目录"。
#     而且这不是可选项：P0-3-3 起 rootfs 就是只读的（`--read-only`），
#     agent-dir 只可能落在 tmpfs 上 —— 播种这一步在那时**必然**存在。
#
# 【语义】
#   PI_AGENT_SEED     = 只读种子（镜像里烤好的那份，agent 不可写）
#   PI_CODING_AGENT_DIR = pi 实际使用的 agent-dir（**必须可写**）
#   两者相同时不做任何拷贝（允许有人故意把 agent-dir 指回种子目录，便于对照实验）。
# =====================================================================

set -euo pipefail

SEED_DIR="${PI_AGENT_SEED:-/opt/pi/agent}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"

if [ "$AGENT_DIR" != "$SEED_DIR" ]; then
  mkdir -p "$AGENT_DIR"
  # `-a` 保留目录结构与权限、`-n` 不覆盖已存在的文件 ⇒ 幂等（可重入；容器内 agent-dir 本身就
  # 是一次性的，但重入性让"在活容器里手动再跑一次"也安全）。
  cp -an "$SEED_DIR/." "$AGENT_DIR/"
fi

exec pi "$@"
