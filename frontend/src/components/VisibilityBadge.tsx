/**
 * 资产可见范围徽标（P1-13 初版 + P1-18 三档）
 *
 * 依据：`子方案/资产共享与用户组标签.md` §三、`shared/src/assetAcl.ts`（`ASSET_VISIBILITY_KEY`
 *      是可见范围文案的**唯一来源** —— 各处自己拼一份就会「公开 / 公有 / 全员可见」各说各话）。
 *
 * Agent / 知识库 / MCP server 共用同一个徽标（Provider 已无可见范围）。
 * 列表页据此一眼看出"这条别人能不能看见"。**判据来自服务端下发的 `visibility` 字段**，
 * 前端不自己算（与 `canEdit` 同一条纪律：代替后端判权限是禁止的，读后端判好的结论是允许的）。
 * 知识库 / MCP 只会是 `PRIVATE`/`PUBLIC`（两档），`SHARED` 仅 Agent 出现。
 *
 * ⚠️ P1-23 第七批：随「知识库」批一起迁到按 key 取译文（它是 `ASSET_VISIBILITY_KEY` 的消费方，
 * 与其另一个消费方 `KnowledgeBaseFormModal` 同批；中文那份 `ASSET_VISIBILITY_LABELS` 仍在
 * `shared` 给后端与未迁批次用 —— 见 `子方案/界面语言切换.md` §3.5）。
 */

import { Tag } from 'antd'
import { translate, ASSET_VISIBILITY_KEY, type AssetVisibility } from '@doubulea/shared'

import { useT } from '../app/i18n.js'

export function VisibilityBadge({ visibility }: { visibility: AssetVisibility }) {
  const { locale } = useT()
  const className = visibility === 'PUBLIC' ? 'tag--accent' : visibility === 'SHARED' ? 'tag--shared' : undefined
  return <Tag className={className}>{translate(locale, ASSET_VISIBILITY_KEY[visibility])}</Tag>
}
