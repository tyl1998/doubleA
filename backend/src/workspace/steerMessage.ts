/**
 * 工作区 USER 写事件 → 给运行中 agent 的插话文案（P1-9 · P4 · R1）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 5（主动 awareness：watcher 检测到 USER 写且该轮
 *      agent 正在跑 ⇒ 用 pi RPC `steer` 注入"用户修改了 path（vN），请重新读取后再继续"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个**纯函数文件**（不塞进 `taskAgent.ts`）
 * ─────────────────────────────────────────────────────────────────────
 * 它是一条可以被无依赖档逐字断言的**判据**（谁该回喂、回喂什么文案），而 `taskAgent.ts` 一被
 * import 就会拉起沙箱 / Redis / Prisma 一整串（跑不了"无 DB / 无 Docker"的自证）。
 * 抽到 `workspace/` 下之后，`workspace:regression` 能像断言 `foldWorkspaceEvents` 那样断言它。
 *
 * ⚠️ **只认 `USER` 的内容事件**（`WORKSPACE_CONTENT_EVENT_TYPES`：created/updated/deleted/renamed）：
 *   · `AGENT`（agent 自己的工具写）不回喂 —— 它自己知道；
 *   · `SYSTEM`（watcher 兜底捕获的 `bash` 写）不回喂 —— 那也是 agent 自己的手；
 *   · `claim` / `release`（并发协议的内部事件）不回喂 —— 它们不改字节，只会打扰模型。
 */
import { WORKSPACE_CONTENT_EVENT_TYPES, type WorkspaceEventItem } from '@doubulea/shared'

/**
 * 工作区事件 → 给运行中 agent 的插话文案；**不该回喂的事件返回 `null`**。
 *
 * `version` 为 `null` 时省略括注（内容事件理论上都带版本，这里只是**不编造**一个数）。
 */
export function workspaceEditSteerMessage(event: WorkspaceEventItem): string | null {
  if (event.actor !== 'USER') return null
  if (!(WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(event.type)) return null
  const version = event.version === null ? '' : `（v${event.version}）`
  switch (event.type) {
    case 'created':
      return `用户新建了 ${event.path}${version}，请重新读取后再继续`
    case 'updated':
      return `用户修改了 ${event.path}${version}，请重新读取后再继续`
    case 'deleted':
      return `用户删除了 ${event.path}，该文件已不存在，请勿再引用它`
    case 'renamed':
      return `用户重命名或移动了 ${event.path}${version}，请重新读取后再继续`
    default:
      // claim / release（上面的 `includes` 已过滤掉，这里只为穷尽 switch）
      return null
  }
}
