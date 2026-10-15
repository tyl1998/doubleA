#!/usr/bin/env bash
# =====================================================================
# install-python-version.sh <版本>  —— 构建期为"版本化运行时"装一个指定 CPython（P1-17a 增量）
#
# 【为什么要它】Debian bookworm 自带 python3.11；要 3.10 / 3.8 就得**构建期**另装一个
#   （运行期装版本违背"运行时预烘焙"的定案）。这里用 `uv`（astral）的独立 CPython 构建：
#   `uv python install <ver>` 从 pypi 侧的独立发行版拉（走允许的注册表出网）。
#
# 【装到哪 / 怎么被找到】
#   · 解释器装进 `/opt/uv-python`（**不是 root 家目录** —— 运行期容器用户是 `agent`，读不到 /root）；
#     装完 `chmod -R a+rX` 让 agent 能执行。
#   · **软链** `/usr/local/bin/python3.10` → 该解释器（PATH 里 /usr/local/bin 在前）⇒ 用户在容器里
#     直接 `python3.10 -m venv .venv && .venv/bin/pip install -r requirements.txt` 即可。
#   · ⚠️ **不动系统 `python3`**（那仍是 3.11）：多版本**并存**，各叫各的名字 —— 这也避免把
#     toolkit 的 pandas/openpyxl 弄丢（它们挂在系统 3.11 上）。
#
# 【pip 必须可用】uv 管理的解释器默认可能不带 pip ⇒ 装完**显式 `ensurepip`**，并**断言 pip 能跑**；
#   跑不起来就让 build **红**（见 selfcheck 的同一口径）。
# =====================================================================

set -euo pipefail

version="${1:-}"
if [ -z "${version}" ]; then
  echo '用法: install-python-version.sh <版本，如 3.10 / 3.8>' >&2
  exit 1
fi

export UV_PYTHON_INSTALL_DIR=/opt/uv-python
export UV_PYTHON_PREFER_SYSTEM=0

# 1) uv 从 pypi 装（构建期出网；pypi/files.pythonhosted 在 REGISTRY 放行集里）。
#    bookworm 的 python3 是 externally-managed ⇒ 需要 --break-system-packages。
python3 -m pip install --no-cache-dir --break-system-packages uv

# 2) 装指定 CPython（独立发行版）
uv python install "${version}"

# 3) 找解释器路径并软链成 pythonX.Y（与系统 python3 并存）
pybin="$(uv python find "${version}")"
ln -sf "${pybin}" "/usr/local/bin/python${version}"

# 4) 确保 pip 可用（uv 的发行版通常带 ensurepip）
if ! "/usr/local/bin/python${version}" -m pip --version >/dev/null 2>&1; then
  "/usr/local/bin/python${version}" -m ensurepip --upgrade
fi
"/usr/local/bin/python${version}" -m pip --version

# 5) 让非 root（agent，uid 10001）也能读/执行
chmod -R a+rX /opt/uv-python
echo "python${version} 就绪：$(readlink -f "/usr/local/bin/python${version}")"
