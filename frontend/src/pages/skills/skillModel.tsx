/**
 * Skill 页面的纯函数与徽标（P1-24a-2）
 *
 * 依据：`docs/03-前端设计.md` §4.2（Agent 编辑页的 Skill 区四条口径）、§二（`/skills` / `/skills/:id`）、
 *      `子方案/Skill能力.md` §5.2 / §5.3、`shared/src/skill.ts`。
 *
 * 这里只放**两个页面共用**的东西：运行时徽标、以及"Agent 表单里能不能选这个 Skill"的判据。
 * 判据写成纯函数而不是散在组件里，是因为它同时决定**选项可勾选**与**勾了之后会不会被服务端 409 打回**
 * —— 两处各写一遍的那天，界面上就会出现"能勾，但保存必失败"。
 */

import { Tag } from 'antd'
import type { MessageKey, SkillRuntime } from '@doubulea/shared'

import { useT } from '../../app/i18n.js'

/** 运行时徽标的文案（`SANDBOX` 额外带"需要 TaskAgent"的说明，见 `SKILL_RUNTIMES` 注释） */
const RUNTIME_KEY: Readonly<Record<SkillRuntime, MessageKey>> = {
  INLINE: 'skillBadge.inline',
  SANDBOX: 'skillBadge.sandbox',
}

/** `skill.runtime` 徽标 + 「含脚本」徽标（列表 / 详情 / Agent 表单共用一份文案） */
export function SkillBadge({ runtime, hasScripts = false }: { runtime: SkillRuntime; hasScripts?: boolean }) {
  const { t } = useT()
  return (
    <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
      <Tag className={runtime === 'SANDBOX' ? 'tag--warn' : undefined}>{t(RUNTIME_KEY[runtime])}</Tag>
      {hasScripts && <Tag color="orange">{t('skillBadge.hasScripts')}</Tag>}
      {runtime === 'SANDBOX' && <span className="ratio">{t('skillBadge.sandboxHint')}</span>}
      {runtime === 'INLINE' && !hasScripts && (
        <span className="ratio">{t('skillBadge.inlineBindable')}</span>
      )}
      {runtime === 'INLINE' && hasScripts && (
        <span className="ratio">{t('skillBadge.scriptTaskAgentOnly')}</span>
      )}
    </span>
  )
}

/**
 * 这个 Skill 能不能被**当前 Agent 类型**绑定（与 `agent.service.ts#assertComponentRefsBindable` 同口径）。
 *
 * · `CHATBOT` 只能绑 `INLINE`（脚本只在 TaskAgent 沙箱里跑 ⇒ 服务端 409 `SKILL_RUNTIME_NOT_ALLOWED`）；
 * · `SANDBOX` 的**他人作品**只有 ADMIN 能绑（服务端 403 `SKILL_SANDBOX_FOREIGN_DENIED`，只能 fork 后绑）；
 * · 其余一律可选。
 *
 * ⚠️ 前端据此把选项**置灰**而不是隐藏：藏起来会让"我的 Skill 列表里明明有它、表单里却没有"
 * 变成一件必须猜的事；置灰 + 一行原因能直接说清"要换成 TaskAgent"。
 */
export function skillBindability(
  skill: { runtime: SkillRuntime; createdBy: string; hasScripts?: boolean },
  context: { agentType: 'CHATBOT' | 'TASK_AGENT'; viewerId: string | undefined; viewerIsAdmin: boolean },
): { selectable: true } | { selectable: false; reasonKey: MessageKey } {
  if (context.agentType === 'CHATBOT' && skill.runtime === 'SANDBOX') {
    return { selectable: false, reasonKey: 'agentForm.skillChatbotSandbox' }
  }
  // 旧包可能把 vision.js 放在根目录：跨目录识别到脚本后，**新绑定**也不允许进 ChatBot
  if (context.agentType === 'CHATBOT' && skill.hasScripts === true) {
    return { selectable: false, reasonKey: 'agentForm.skillChatbotScripts' }
  }
  const mine = context.viewerId !== undefined && skill.createdBy === context.viewerId
  if (skill.runtime === 'SANDBOX' && !mine && !context.viewerIsAdmin) {
    return { selectable: false, reasonKey: 'agentForm.skillForeignSandbox' }
  }
  return { selectable: true }
}

/**
 * ChatBot 只列 `INLINE`（`子方案` §5.2 第 2 条）；TaskAgent 列全部。
 *
 * 与 {@link skillBindability} 的分工：本函数决定**列不列**，后者决定**能不能勾**。
 * ChatBot 下 `SANDBOX` 不列（列表里根本没有可用的东西，灰着一堆反而噪音）；他人 sandbox 在
 * TaskAgent 下**列但置灰**（用户需要看到"有这个 Skill，但得先复制成自己的"）。
 */
export function visibleSkillsFor<T extends { runtime: SkillRuntime }>(
  skills: readonly T[],
  agentType: 'CHATBOT' | 'TASK_AGENT',
): T[] {
  return agentType === 'CHATBOT' ? skills.filter((skill) => skill.runtime === 'INLINE') : [...skills]
}
