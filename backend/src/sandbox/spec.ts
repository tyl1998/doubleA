/**
 * 沙箱的「名字 · 标签 · 创建规格」（P0-3-2）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §四 1（会话即容器 / label 契约）、§四 2（资源与文件系统）、
 *      §九 1（具名卷，`docker rm` 必须带 `-v`）、§二（数值常量总表）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件：**这里全是纯函数**
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**不 import `dockerode`、不 import `config`、不碰 Redis**（只用 `import type` 拿它的类型，
 * 编译后被抹掉）—— 于是"标签怎么拼、容器名怎么算、孤儿怎么判"这些**唯一判据**可以在不连 Docker、
 * 不连库的情况下逐条比对（同一手法见 `orchestrator/semaphore.ts` 与 `pipeline/chunk/`）。
 * 带副作用的动作（真建容器 / 真删卷）在 `docker.ts` 与 `manager.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ label 是"这东西是不是我们的"的**唯一判据**（`子方案③` §四 1 原文）
 * ─────────────────────────────────────────────────────────────────────
 * `sandboxes` 表**不是**归属判据：后端崩在「容器已建、行还没写」之间时，表里没有它、而 label 在。
 * 于是：
 *   · **label 回答"是不是我们的"** ⇒ 对账器（`reaper.ts`）列容器/卷**只按这组 label 列**；
 *   · **表回答"该不该活着"**（`RUNNING` / 宽限期内的 `CREATING`）⇒ 对账器再拿它做第二问。
 * 两个问题都要问，但**不能互相替代** —— 漏打一个 label 就等于清道夫看不见它（§四 1 原话）。
 */

import type Docker from 'dockerode'

/** 角色标签的键：值恒为 {@link SANDBOX_ROLE}（`doubulea.role=sandbox`） */
export const SANDBOX_LABEL_ROLE = 'doubulea.role'
/** 会话标签的键：值 = `conversations.id`（UUID）。**对账器按它把容器/卷归到会话上** */
export const SANDBOX_LABEL_CONVERSATION = 'doubulea.conversation'
/**
 * 启动时刻标签的键：值 = ISO 字符串。
 * ⚠️ 它**不是**空闲回收的判据 —— 判据是库里的 `sandboxes.last_active_at`（"最后一次**引擎事件**"，
 * 见 `schema.prisma` 的 Sandbox 注释）。这个标签只用于排障（`docker inspect` 时人眼能看出
 * "这个容器是哪一轮起的"），写在这里是为了避免下一个人误以为它参与判定。
 */
export const SANDBOX_LABEL_STARTED_AT = 'doubulea.startedAt'

/** 角色标签的值 */
export const SANDBOX_ROLE = 'sandbox'

/** 容器内工作目录 = work 卷的挂载点（`子方案③` §四 2：产物唯一落点） */
export const SANDBOX_WORK_DIR = '/work'

/** 具名卷名前缀。⚠️ 名字必须**唯一且可推导**（少一次"这卷是谁的"的考古，`子方案③` §九 1） */
export const WORK_VOLUME_PREFIX = 'doubulea-work-'

/** UUID 形态检查（只用来校验 label 里的会话 id 是不是我们写进去的那种；不做 RFC 全量校验） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** 一个沙箱对象（容器或卷）身上那组标签 */
export interface SandboxLabels {
  conversationId: string
  startedAt: string
}

/** 拼出容器/卷要打的那组标签（容器与卷**用同一组**：对账器可以拿同一个谓词处理两者） */
export function sandboxLabels(input: { conversationId: string; startedAt: Date }): Record<string, string> {
  return {
    [SANDBOX_LABEL_ROLE]: SANDBOX_ROLE,
    [SANDBOX_LABEL_CONVERSATION]: input.conversationId,
    [SANDBOX_LABEL_STARTED_AT]: input.startedAt.toISOString(),
  }
}

/** work 卷名：`doubulea-work-<conversationId>`（一个会话一个卷名 —— 回收后重建时复用同名卷） */
export function workVolumeName(conversationId: string): string {
  return `${WORK_VOLUME_PREFIX}${conversationId}`
}

/**
 * `listContainers` / `listVolumes` 的过滤条件：**只列我们的**。
 * 一处定义、两处使用（容器与卷），免得"容器按 label 列、卷按名字前缀列"这种两套判据悄悄分叉。
 */
export function sandboxFilter(): { label: string[] } {
  return { label: [`${SANDBOX_LABEL_ROLE}=${SANDBOX_ROLE}`] }
}

/** 加上会话维度（回收某个会话时用它，避免误删同名的别的东西） */
export function sandboxFilterFor(conversationId: string): { label: string[] } {
  return { label: [`${SANDBOX_LABEL_ROLE}=${SANDBOX_ROLE}`, `${SANDBOX_LABEL_CONVERSATION}=${conversationId}`] }
}

/**
 * 从对象的标签里解出"它是谁的"。
 *
 * 返回 `undefined` 的两种情形**必须分开对待**（对账器会按"不认识的也删"处理，理由见那里）：
 *   · 角色标签不对/缺失 ⇒ 这压根不是本轮 label 体系的东西；
 *   · 会话标签缺失或不是 UUID ⇒ 打标签的代码有 bug（或有人手工 `docker run` 打了一半标签）⇒
 *     **它仍然是 `doubulea.role=sandbox`，仍然会占着磁盘与名额** ⇒ 必须能删得掉，
 *     否则就成了"看得见、判不了、删不了"的永久残留。
 */
export function readSandboxLabels(labels: Readonly<Record<string, string>> | undefined): SandboxLabels | undefined {
  if (labels === undefined) return undefined
  if (labels[SANDBOX_LABEL_ROLE] !== SANDBOX_ROLE) return undefined
  const conversationId = labels[SANDBOX_LABEL_CONVERSATION]
  if (conversationId === undefined || !UUID_RE.test(conversationId)) return undefined
  return { conversationId, startedAt: labels[SANDBOX_LABEL_STARTED_AT] ?? '' }
}

/**
 * 「这个对象该不该留着」—— 对账器的**唯一判据**，容器与卷共用。
 *
 * @param labels 从对象上读出来的标签（`readSandboxLabels` 的结果）
 * @param liveConversationIds 「本轮活着的会话」集合 = **会话存在且 ACTIVE** ∩
 *        （有 `RUNNING` 行 ∪ 有宽限期内的 `CREATING` 行）。集合怎么算见 `reaper.ts`。
 *
 * 三档结论：
 *   · 标签读不出来 ⇒ **不保留**（见 `readSandboxLabels` 的第二种情形）；
 *   · 标签可读、会话不在活集合里 ⇒ **不保留**（会话被删 / Agent 被软删 / 账本里没有活体行）；
 *   · 在活集合里 ⇒ 保留（空闲的那一批由 `reapIdleSandboxes()` 按 `last_active_at` 另行处理）。
 */
export function keepSandboxObject(labels: SandboxLabels | undefined, liveConversationIds: ReadonlySet<string>): boolean {
  if (labels === undefined) return false
  return liveConversationIds.has(labels.conversationId)
}

/** 造创建参数需要的输入（`config` 由调用方注入，本文件不读配置） */
export interface SandboxContainerSpecInput {
  image: string
  conversationId: string
  volumeName: string
  startedAt: Date
}

/**
 * 容器的创建参数（`docker create` 的等价物）。
 *
 * ⚠️⚠️ **本批刻意只做"生命周期需要的那几项"，安全加固整体留给 P0-3-3**（`docs/06` §五 的批次切分：
 * P0-3-3 = 只读 rootfs / work 卷配额 / `/tmp` tmpfs / mem·cpu·pids 限额 / 非 root + cap-drop /
 * 专用 internal bridge）。本函数里**刻意缺席**的每一项都在下面点名，留给下一批在**同一个函数**里补 ——
 * 它们散在别处就会变成"有人以为配了、其实没配"。
 *
 * 已在位的四项，各自的理由：
 *   · `Labels` —— 见文件头：**归属的唯一判据**；
 *   · `Mounts`（具名卷 → `/work`）—— 产物唯一落点；**具名**是为了让对账器能按 label 找回它
 *     （匿名卷只能靠 `docker rm -v` 顺带清，堆起来就是"磁盘悄悄满"，§九 1）；
 *   · `OpenStdin` + **不设 `Tty`** —— 引擎桥（P0-3-5）走 `pi --mode rpc`（JSONL over **stdio**）⇒
 *     主进程要能一直读 stdin。实测（P0-3-2）：`-i` + `--network none` 下容器稳定 `Up`
 *     （不带 `-i` 时 stdin 直接 EOF、pi 立刻退出 ⇒ 容器起来就死，账本却以为它 `RUNNING`）；
 *   · `NetworkMode: 'none'` —— ★ **本批的临时取值，P0-3-3 会换成专用 internal bridge**。
 *     理由：那时才谈得上"两条白名单出口"；在那之前把容器挂到 Docker 默认 `bridge` 上，
 *     它会**能摸到宿主所有监听端口**（13000 公网口、PG、Redis、MinIO）—— 那是比"能出公网"
 *     更严重的暴露面（§四 3）。取 `none` 是"先关死，等有白名单了再开门"，时序上不会出现
 *     "中间有一版开着门"。
 *
 * ⚠️ **`AutoRemove` 必须是 false**：true 会让容器退出时被 Docker 自己删掉，账本与对账器
 * 就失去了"这次回收发生了什么"的证据，且 `docker rm -v` 的**具名卷仍不会被删**（实测）
 * ⇒ 留下的是"行说回收了、卷还在"的假象。回收路径统一走 `manager.recycleSandbox()`。
 */
export function buildSandboxContainerSpec(input: SandboxContainerSpecInput): Docker.ContainerCreateOptions {
  return {
    Image: input.image,
    Labels: sandboxLabels({ conversationId: input.conversationId, startedAt: input.startedAt }),
    WorkingDir: SANDBOX_WORK_DIR,
    // 引擎桥（P0-3-5）要往 stdin 写 JSONL；保持打开（见上方注释）
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: false,
    Tty: false,
    // ⚠️ Cmd 刻意不设：镜像里 `CMD ["--mode","rpc"]` 就是默认值（P0-3-1 把参数留在 CMD 正是为此）
    HostConfig: {
      AutoRemove: false,
      // 具名卷 → `/work`。⚠️ 写在 `HostConfig.Mounts` 而不是 `Config.Binds`：
      // `--mount` 的语义更明确（不会像 `-v` 那样在宿主上"顺手"建出不存在的目录、
      // 也不会把名字里带 `/` 的东西解释成路径），且类型上就是它的家
      // （Docker inspect 里它也确实落在 `HostConfig.Mounts`）。
      Mounts: [
        {
          Type: 'volume',
          Source: input.volumeName,
          Target: SANDBOX_WORK_DIR,
          ReadOnly: false,
        },
      ],
      // ── P0-3-3 在这里补：ReadonlyRootfs / CapDrop+SecurityOpt / Memory+NanoCpus+PidsLimit /
      //    Tmpfs(/tmp) / StorageOpt(work 卷配额) / NetworkMode(专用 internal bridge) ──
      NetworkMode: 'none',
    },
  }
}
