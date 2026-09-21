# syntax=docker/dockerfile:1
#
# 自建 PostgreSQL 16 镜像：pgvector + pg_bigm
# ═══════════════════════════════════════════════════════════════════════
# 【为什么必须自建】
#   官方 `pgvector/pgvector:pg16` 只含 pgvector，**不含 pg_bigm**；
#   而决策 11（docs/01 §二）把「中文全文检索」定为 pg_bigm bigram —— 因为
#   PostgreSQL 内置 parser 不做中文分词，整句会成为一个 token，`to_tsvector`
#   对中文基本命不中。所以 pg_bigm 是本项目 D 包（知识库流水线）的硬前提。
#
# 【为什么从源码编译 —— P0-1-2 实测排除法，不必再试别的路】
#   ① apt 官方源（bookworm / bookworm-updates / security）：`apt-cache search
#      bigm` 无任何 PG 相关包。
#   ② PGDG 源（apt.postgresql.org，已验证可达、可 update）：同样**没有**
#      `postgresql-16-pg-bigm`，`apt-cache pkgnames | grep bigm` 只返回
#      r-cran-bigmemory（R 语言包，与 PG 无关）。
#   → 结论：pg_bigm 只有源码（GitHub pgbigm/pg_bigm）一条路。实测记录见
#     `issue_fix/问题记录-P0-1-2-基础设施与镜像.md`。
#
# 【验证方式（P0-1-2 验收门槛）】
#   dev-up.ps1 会自动执行 `infra/scripts/pg-verify.mjs`：
#     CREATE EXTENSION vector / pg_bigm   → 均成功
#     SELECT bigm_similarity('中文测试','中文') > 0        → 证明扩展真的可用
#     gin_bigm_ops 算子类存在 + 能建 GIN 索引              → D 包 §4-4 前置
#     HNSW(vector_cosine_ops) 能建索引                     → D 包 §4-4 前置
# ═══════════════════════════════════════════════════════════════════════

FROM pgvector/pgvector:pg16

# pg_bigm 上游版本。
# ⚠️ 上游 tag **带日期后缀**（没有裸的 `v1.2`）—— 用裸 tag 会 404，
#    实测记录见 `issue_fix/问题记录-P0-1-2-基础设施与镜像.md`。
# 发布页：https://github.com/pgbigm/pg_bigm/tags
ARG PG_BIGM_VERSION=1.2
ARG PG_BIGM_RELEASE=20250903
ARG PG_BIGM_TAG=v${PG_BIGM_VERSION}-${PG_BIGM_RELEASE}

# 构建依赖：
#   build-essential          → gcc / make
#   postgresql-server-dev-16 → PG 头文件与 pg_config（pg_bigm 是 PG 扩展，走 PGXS）
#   ca-certificates + curl + xz → 拉取源码 tarball
#
# 【不做的事（实测后刻意省略）】
#   - 不换 Debian apt 镜像：容器内 `apt-get update` 在本机直连 deb.debian.org
#     即可成功（Docker Desktop 的代理已兜住），无需 mirrors.aliyun.com。
#   - 不加 PGDG 源：PGDG 里根本没有 pg_bigm（见上），加了纯属浪费构建时间。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-server-dev-16 \
        ca-certificates \
        curl; \
    rm -rf /var/lib/apt/lists/*

# 编译安装 pg_bigm
#   下载源按「国内镜像 → 官方源」顺序尝试（GitHub Release 直连在国内常超时）；
#   两者实测均可 200（源码仅 36KB）。make install 后**立即断言** control 与 .so
#   落地，把失败提前到构建期 —— 否则要等到 D 包 CREATE EXTENSION 才发现。
#
#   注意：GitHub 的 archive 解压后目录名是 `${TAG 去掉 v}`，即 `pg_bigm-1.2-20250903`，
#   不是 `${TAG}`。这里用通配符 glob 规避，避免日后改 tag 时踩这个坑。
RUN set -eux; \
    cd /tmp; \
    tarball="pg_bigm-${PG_BIGM_TAG}.tar.gz"; \
    upstream="https://github.com/pgbigm/pg_bigm/archive/refs/tags/${PG_BIGM_TAG}.tar.gz"; \
    mirrors="https://ghfast.top/${upstream} https://gh-proxy.com/${upstream}"; \
    downloaded=0; \
    for url in $mirrors $upstream; do \
        if curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 180 -o "$tarball" "$url"; then \
            downloaded=1; echo "downloaded from: $url"; break; \
        fi; \
        echo "mirror failed, trying next: $url"; \
    done; \
    [ "$downloaded" = "1" ] || { echo "FATAL: 所有 pg_bigm 下载源均失败"; exit 1; }; \
    tar -xzf "$tarball"; \
    cd pg_bigm-*; \
    make USE_PGXS=1; \
    make USE_PGXS=1 install; \
    cd /; \
    rm -rf /tmp/pg_bigm*; \
    test -f "$(pg_config --sharedir)/extension/pg_bigm.control"; \
    test -f "$(pg_config --pkglibdir)/pg_bigm.so"; \
    echo "pg_bigm ${PG_BIGM_TAG} installed OK"

# 收尾：删掉只用于编译的包，减小镜像体积（实测约 -120MB）。
#   pg_config 随 postgresql-server-dev-16 一起被删；运行期 entrypoint 不依赖它，
#   故安全 —— 但**不要**把 pg_config 调用挪到这之后。
RUN set -eux; \
    apt-get purge -y --auto-remove build-essential postgresql-server-dev-16 curl; \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 首次初始化（空数据卷）时自动建扩展。
#   /docker-entrypoint-initdb.d/ 由官方 entrypoint 在 initdb 后执行，
#   仅当数据目录为空时运行一次；已有数据的卷不会重跑
#   （符合预期：扩展创建后持久化在库内，无需每次启动重复执行）。
COPY initdb/ /docker-entrypoint-initdb.d/
RUN chmod 0644 /docker-entrypoint-initdb.d/*.sql
