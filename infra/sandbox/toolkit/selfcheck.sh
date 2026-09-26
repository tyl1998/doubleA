#!/usr/bin/env bash
# =====================================================================
# selfcheck.sh — 沙箱 toolkit 层的**依赖自检**（P0-3-1；`子方案③` §五 2）
#
# 【它为什么是镜像构建的一部分，而不是一个可选脚本】
#   运行期不允许安装（egress 白名单只放行模型池 ⇒ 容器内 pip/npm 必然失败），所以
#   "少一个库"这件事**只能在构建期发现**。不在这里失败，症状就是：
#   镜像 build 成功 → 派活时模型写 pandas 脚本 → 失败 → 一条含糊的引擎 stderr
#   （§六 3：引擎 stderr 不进 SSE、只进后端日志，前端什么都看不到）。
#
# 【跑在什么身份下】
#   toolkit/Dockerfile 里是 `USER agent` 之后才跑它 ⇒ 顺带把"非 root 下这些工具真能用"
#   一起验了。以 root 跑的自检会放过一堆权限问题（work 卷写不进去 etc.）。
#
# 【在活容器里怎么重跑】
#   docker run --rm -it --entrypoint /opt/sandbox-selfcheck.sh doubulea/sandbox-toolkit:1
#   （排障时先跑这个，能把"镜像问题"与"用法问题"分开）
#
# ⚠️ 它**不检查网络** —— "两条出口"的正面/反面取证要靠真容器 + iptables，属 P0-3-3。
# =====================================================================

set -uo pipefail

failures=0
ok()      { printf '  [ok]   %s\n' "$1"; }
bad()     { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }
section() { printf '\n== %s ==\n' "$1"; }
indent()  { sed 's/^/         /'; }

# 跑一条命令：成功 → ok，失败 → bad；两种情况下都把它自己的输出缩进打印出来
# （构建日志里要能看到**实际版本号**，那是下一次改基线时的对照值）。
check() {
  local label="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    ok "$label"
  else
    bad "$label"
  fi
  [ -n "$out" ] && printf '%s\n' "$out" | indent
  return 0
}

printf '沙箱 toolkit 依赖自检（P0-3-1）\n'

# ── 1. 身份与可写点 ────────────────────────────────────────────────────
section '身份与可写点'
check '非 root（镜像默认用户是 agent）' bash -c 'test "$(id -u)" != "0" && id'
# /work 与 /tmp 是两个**唯一**的可写落点（§四 2：rootfs 只读；/tmp 是 tmpfs；work 是具名卷）。
# 它们在 base 层/挂载时才成型 —— 这里只证明"以 agent 身份能写"，配额与只读 rootfs 属 P0-3-3。
check '/work 可写（work 卷挂载点）' bash -c 'touch /work/.selfcheck && rm -f /work/.selfcheck && echo ok'
check '/tmp 可写（P0-3-3 起会换成 tmpfs 挂载点）' bash -c 'touch /tmp/.selfcheck && rm -f /tmp/.selfcheck && echo ok'

# ── 2. pi（引擎）───────────────────────────────────────────────────────
section 'pi（引擎）'
check 'pi 可执行且能报版本' bash -c 'pi --version'
check 'pi --help 可跑（扩展可注册 flag，这里是加载链的最早一环）' bash -c 'pi --help > /dev/null && echo ok'

# ── 3. pi 配置、播种与桥扩展（§五 1；⚠️ 本组守的是构建期实测到的一个**静默** bug）──
section 'pi 配置、播种与桥扩展'
check 'PI_AGENT_SEED 已设置（只读种子）' bash -c 'test -n "${PI_AGENT_SEED:-}" && echo "$PI_AGENT_SEED"'
# 两者**必须不同**：pi 的工作目录要可写（见下），而种子刻意不可写。
check 'PI_CODING_AGENT_DIR 已设置且不等于种子目录' \
  bash -c 'test -n "${PI_CODING_AGENT_DIR:-}" && test "$PI_CODING_AGENT_DIR" != "$PI_AGENT_SEED" && echo "$PI_CODING_AGENT_DIR"'
check '种子里有 settings.json' bash -c 'test -f "$PI_AGENT_SEED/settings.json" && echo ok'
# 这条断言守的是一个**刻意的决定**：种子属于镜像、不属于会话。
# 若哪天有人为了让 pi 能写而把这里 chmod 放开，这里会红 —— 那是提醒，不是障碍
# （正确的修法是播种到可写区，见 entrypoint.sh）。
check '种子对 agent 只读（配置放只读层里）' bash -c 'test ! -w "$PI_AGENT_SEED" && echo ok'
# Key 只在容器环境变量里（§五 3），任何"落盘的凭据"都是回归。
check '种子里没有 auth.json（凭据不落盘）' bash -c 'test ! -e "$PI_AGENT_SEED/auth.json" && echo ok'
check 'entrypoint 可执行' bash -c 'test -x /opt/pi/entrypoint.sh && echo ok'

# ★ 行为级断言，**反例 + 正例成对**（只写正例证明不了这条探针有效 —— `06` 的断言纪律 ⑫）：
#   pi 读 settings.json 时会**先在同目录加一把锁**（`settings.json.lock`，mkdir）⇒ 目录不可写时，
#   它把整份 settings 判为 **invalid 并整体忽略**（不是"跳过这一项"）⇒ `sessionDir` /
#   `defaultProjectTrust` / `enableInstallTelemetry` 全部悄悄不生效。
#   ① **反例** = 直接把只读的种子目录当 agent-dir ⇒ **必须**报 `Invalid settings file`
#      （证明这条探针真的抓得到"配置目录不可写"）
#   ② **正例** = 走 entrypoint 播种到可写目录 ⇒ **必须不报**
#   ⚠️ 探针命令就是当时发现问题的那个：**`pi --help` 会读 settings**。别换成 `--version` 之类
#      不读配置的子命令 —— 那样两条都会"通过"，而什么都没验到。
out="$(PI_CODING_AGENT_DIR="$PI_AGENT_SEED" pi --help 2>&1 || true)"
if printf '%s\n' "$out" | grep -q 'Invalid settings file'; then
  ok '反例成立：只读目录当 agent-dir ⇒ pi 报 settings 无效（探针有效）'
else
  bad '反例不成立：只读目录当 agent-dir 时 pi 没报 settings 无效（探针失效 ⇒ 下面那条正例不可信）'
fi

sc_agent=/tmp/selfcheck-agent
rm -rf "$sc_agent"
if out="$(PI_CODING_AGENT_DIR="$sc_agent" /opt/pi/entrypoint.sh --help 2>&1)"; then
  if printf '%s\n' "$out" | grep -q 'Invalid settings file'; then
    bad '正例失败：entrypoint 播种后 pi 仍报 settings 无效'
    printf '%s\n' "$out" | head -n 3 | indent
  else
    ok '正例成立：entrypoint 播种后 pi 正常读到 settings（无 Invalid settings file）'
  fi
else
  bad '正例失败：entrypoint 播种后 pi --help 退出码非 0'
  printf '%s\n' "$out" | head -n 3 | indent
fi
check '播种结果里有 settings.json 与桥扩展' \
  bash -c 'test -f /tmp/selfcheck-agent/settings.json && test -f /tmp/selfcheck-agent/extensions/mcp-bridge/index.ts && echo ok'

# mcp-bridge 的加载检查：**语法级**证明 —— 它能否作为一个 ESM 模块被求值、default 是不是函数。
# 为什么复制成 .mts：agent-dir 下没有 package.json，Node 的类型擦除会按 CJS 解释 `.ts`，
# 而扩展是 ESM 写法（`export default`）⇒ 直接 import 原路径会以一个**与扩展无关**的错失败。
# ⚠️ 它**不证明** pi 侧的 jiti 也认得它 —— 那要等 P0-3-5 的真容器冒烟（本批只保证"文件进了镜像"）。
bridge_copy=/tmp/selfcheck-bridge.mts
cp "$sc_agent/extensions/mcp-bridge/index.ts" "$bridge_copy"
if out="$(node --no-warnings -e "
import('$bridge_copy').then((m) => {
  if (typeof m.default !== 'function') { console.error('default 不是函数'); process.exit(1) }
  console.log('default export: function')
}).catch((e) => { console.error(String((e && e.message) || e)); process.exit(1) })
" 2>&1)"; then
  ok 'mcp-bridge 扩展可作 ESM 求值（default 是函数）'
else
  bad 'mcp-bridge 扩展可作 ESM 求值（default 是函数）'
fi
[ -n "$out" ] && printf '%s\n' "$out" | indent
rm -f "$bridge_copy"
rm -rf "$sc_agent"

# ── 4. toolkit 依赖（本层存在的全部意义）───────────────────────────────
section 'toolkit 依赖'
check 'python3 版本' bash -c 'python3 -VV'
check 'pandas / numpy / openpyxl 可导入' bash -c \
  'python3 -c "import pandas, numpy, openpyxl; print(\"pandas\", pandas.__version__, \"| numpy\", numpy.__version__, \"| openpyxl\", openpyxl.__version__)"'
check 'jq 可跑（stdin → json → stdout）' bash -c 'printf "{\"a\":1}\n" | jq -e ".a == 1" > /dev/null && jq --version'
check 'git 可跑' bash -c 'git --version'
check 'ripgrep 可跑' bash -c 'rg --version | head -n 1'

# 验收场景「分析这份 CSV 出汇总表」的**最小复现**：只 import 成功是不够的 ——
# `openpyxl` 单独缺一个，`import pandas` 照样绿，而 `to_excel` 才炸。
# 所以这里真写一个 xlsx 再读回来（含中文列名，顺带证明编码链没问题）。
if out="$(python3 - <<'PY' 2>&1
import os
import sys
import pandas as pd
import openpyxl

csv_path = '/tmp/selfcheck.csv'
xlsx_path = '/tmp/selfcheck.xlsx'
with open(csv_path, 'w', encoding='utf-8') as fh:
    fh.write('名称,数量\n甲,1.5\n乙,2.5\n')

frame = pd.read_csv(csv_path)
frame['数量'] = frame['数量'] * 2
frame.to_excel(xlsx_path, index=False, engine='openpyxl')
back = pd.read_excel(xlsx_path)
if list(back.columns) != ['名称', '数量'] or len(back) != 2 or float(back['数量'][0]) != 3.0:
    print('roundtrip mismatch: %r' % (back.to_dict('list'),), file=sys.stderr)
    sys.exit(1)
os.remove(csv_path)
os.remove(xlsx_path)
print('pandas %s + openpyxl：csv→汇总→xlsx 往返一致' % pd.__version__)
PY
)"; then
  ok 'CSV → pandas 汇总 → xlsx 往返（验收场景的最小复现）'
else
  bad 'CSV → pandas 汇总 → xlsx 往返（验收场景的最小复现）'
fi
[ -n "$out" ] && printf '%s\n' "$out" | indent

# ── 5. TLS、入口与"这条路要一直是死的" ────────────────────────────────
section 'TLS、入口与负向约束'
# 缺 CA 包的症状是 pi 调模型池时抛 TLS 证书链错误 —— 看着像"容器网络不通"（§四 3 出口①），
# 会把人引到 iptables 上去查。
check 'CA 证书包存在（否则调模型池报 TLS 错，误诊成网络问题）' \
  bash -c 'test -s /etc/ssl/certs/ca-certificates.crt && echo ok'
check 'tini 存在（PID 1 僵尸回收；ENTRYPOINT 用它）' bash -c 'test -x /usr/bin/tini && echo ok'
# ⚠️ 这是一条**反向断言**：守住 toolkit/Dockerfile 里"刻意不装 pip"的决定。
# 有了 pip，"运行期安装"这条路就又开着（然后必然撞 egress 白名单，失败得莫名其妙）；
# 没有 pip ⇒ 失败得更早、更好解释。有人哪天顺手加上，这里会红。
check '刻意没有 pip（运行期安装这条路要一直是死的）' \
  bash -c '! command -v pip >/dev/null && ! command -v pip3 >/dev/null && ! python3 -m pip --version >/dev/null 2>&1 && echo ok'

# ── 汇总 ───────────────────────────────────────────────────────────────
if [ "$failures" -ne 0 ]; then
  printf '\n[FATAL] toolkit 依赖自检未通过：%d 项（详见上方 [FAIL]）\n' "$failures" >&2
  exit 1
fi
printf '\n[OK] toolkit 依赖自检全部通过\n'
