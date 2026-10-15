#!/usr/bin/env bash
# =====================================================================
# selfcheck.sh — 沙箱**运行时层**的自检（P1-17a；`子方案/Code模式工作区.md` §五之二 2）
#
# 【它为什么是镜像构建的一部分】
#   同 toolkit：运行期装依赖要能跑起来，前提是**语言运行时本身在**。不在构建期红掉，
#   症状就是"派活时模型写 `npm test` → 失败 → 一条含糊的引擎 stderr"（前端看不到）。
#
# 【参数】$1 = COMPONENTS（`lang=ver,lang=ver,…`，与 Dockerfile 的 build-arg 同形）
#   空 = 不装语言运行时（只有 toolkit），仅做公共自检。
#   ⚠️ node / python 有 base/toolkit 自带的固定版本 ⇒ 非自带版本用带版本号的命令名（`node20` / `python3.12`）；
#      go / java / rust 在本层独占 ⇒ 用系统命令名（`go` / `java` / `rustc`）。
#
# 【跑在什么身份下】runtime/Dockerfile 里是 `USER agent` 之后才跑它 —— 顺带验非 root 可用。
#
# 【在活容器里怎么重跑】
#   docker run --rm -it --entrypoint /opt/sandbox-runtime-selfcheck.sh \
#     doubulea/sandbox-runtime:node20-python312-v3 'node=20,python=3.12'
# =====================================================================

set -uo pipefail

COMPONENTS="${1:-}"
failures=0
ok()  { printf '  [ok]   %s\n' "$1"; }
bad() { printf '  [FAIL] %s\n' "$1" >&2; failures=$((failures + 1)); }
section() { printf '\n== %s ==\n' "$1"; }
indent()  { sed 's/^/         /'; }

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

printf '沙箱运行时自检（P1-17a）｜ COMPONENTS=%s\n' "${COMPONENTS:-（空）}"

section '身份与公共前提'
check '非 root（镜像默认用户是 agent）' bash -c 'test "$(id -u)" != "0" && id'
# 运行时由 base/toolkit 继承；这两条是"跑项目"的前提，与具体语言无关。
check 'pi（引擎）可执行' bash -c 'pi --version'
check '/work 可写（work 卷挂载点）' bash -c 'touch /work/.selfcheck && rm -f /work/.selfcheck && echo ok'

if [ -z "${COMPONENTS}" ]; then
  section '无语言组件（只有 toolkit）'
  ok 'COMPONENTS 为空：不检查语言运行时'
else
  section "语言组件：${COMPONENTS}"
  for component in $(echo "${COMPONENTS}" | tr ',' ' '); do
    lang="${component%%=*}"
    ver="${component#*=}"
    case "${lang}" in
      node)
        if [ "${ver}" = "22" ]; then
          # 22 = base 自带（系统 node/npm）
          check "node 可跑（${component}）" bash -c 'node --version'
          check "npm 可跑（${component}）" bash -c 'npm --version'
        else
          # 18 / 20 = install-node-version.sh 装的版本化发行版，命令名带版本号
          check "node${ver} 可跑（${component}）" bash -c "node${ver} --version"
          check "npm${ver} 可跑（${component}）" bash -c "npm${ver} --version"
        fi
        ;;
      python)
        if [ "${ver}" = "3.11" ]; then
          check "python3 可跑（${component} = 系统自带）" bash -c 'python3 -VV'
          check "pip 可跑（${component}）" bash -c 'python3 -m pip --version'
        else
          check "python${ver} 可跑（${component}）" bash -c "python${ver} -VV"
          check "python${ver} 有 pip（${component}）" bash -c "python${ver} -m pip --version"
        fi
        ;;
      go)
        # go 在本层独占 ⇒ 系统命令名（install-go-version.sh 装的）
        check "go 可跑（${component}）" bash -c 'go version'
        ;;
      java)
        check "java 可跑（${component}）" bash -c 'java -version'
        check "javac 可跑（${component}）" bash -c 'javac -version'
        check "maven 可跑（${component}）" bash -c 'mvn -version'
        ;;
      rust)
        check "rustc 可跑（${component}）" bash -c 'rustc --version'
        check "cargo 可跑（${component}）" bash -c 'cargo --version'
        ;;
      *)
        bad "未知的组件语言 ${lang}（${component}）"
        ;;
    esac
  done
fi

if [ "$failures" -ne 0 ]; then
  printf '\n[FATAL] 运行时自检未通过：%d 项（详见上方 [FAIL]）\n' "$failures" >&2
  exit 1
fi
printf '\n[OK] 运行时自检全部通过（COMPONENTS=%s）\n' "${COMPONENTS:-（空）}"
