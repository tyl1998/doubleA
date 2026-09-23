/**
 * 知识库的创建 / 编辑弹窗（P0-1-35）
 *
 * 依据：`docs/03` §七「创建/编辑形态」——**字段 ≤6 的实体用弹窗**（KB、MCP server、用户、
 *      模型；Agent 走独立页），且"**同一实体创建与编辑同形态**"；§4.3（详情页顶部要有
 *      "名称/描述/检索配置编辑"）；`design/knowledge.html` 的字段与提示口径。
 *
 * 两种形态共用一个组件（同一个实体不该有两套字段布局）：`kb === null` 是创建、否则是编辑。
 * 差异只有三处，判据都在 {@link knowledgeModel} 里：
 *   ① **创建时 `chunkSize` / `chunkOverlap` 允许留空** ⇒ 不带这两个键，服务端用环境默认值
 *      快照（`shared` 的 `createKnowledgeBaseBodySchema` 注释）。**刻意不预填数字**：
 *      那两个默认值来自部署环境，前端读不到，预填等于拿猜测覆盖部署配置。
 *      编辑时值已知（就是当前值），所以是必填数字。
 *   ② 创建走 `POST`（字段一次给全），编辑走 `PATCH`（**只发真的变了的字段** + 三态）。
 *   ③ 编辑时若一个字段都没改 ⇒ **不发请求**（`buildKnowledgeUpdateBody` 返回 `null`），
 *      只提示一句 —— 少一次写，也少掉一次"保存成功其实什么都没改"的误导。
 *
 * `retrievalConfig` **不在这里**：它有 7 个字段（mode/topK/score/rrfK/splitStrategy/两个权重），
 * 与本弹窗的 4 个字段是两件事（一个答"这个库是什么"，一个答"它怎么检索"）。它单独一个弹窗
 * （{@link KnowledgeConfigModal}），入口在详情页的「检索配置」卡上。
 *
 * ⚠️ 表单的标签用 `<p className="block-label">` 而不是 `<label htmlFor>`：`styles/app.css`
 * 里**没有** `.field__label` 这类原型类名（`06` P0-1-30 定案："AntD 已有的样式不重写，
 * 自写 CSS 只放 AntD 表达不了的结构"）—— 照原型类名写会得到一个**完全没有样式**的 div。
 * 可访问性靠 `aria-label`（与 P0-1-31 的编辑页同一写法）。
 */

import { Alert, Input, InputNumber, Modal } from 'antd'
import type { KnowledgeBaseItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useCreateKnowledgeBase, useUpdateKnowledgeBase } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import {
  buildCreateBody,
  buildKnowledgeUpdateBody,
  editValuesOf,
  validateChunking,
  type KnowledgeCreateFormValues,
  type KnowledgeEditFormValues,
} from './knowledgeModel.js'

export interface KnowledgeBaseFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个库 */
  kb: KnowledgeBaseItem | null
  open: boolean
  onClose: () => void
  /** 创建成功后的去处（列表页用它把用户带到详情页：刚建完最想看的就是"传个文档"） */
  onCreated?: (created: KnowledgeBaseItem) => void
}

export function KnowledgeBaseFormModal({ kb, open, onClose, onCreated }: KnowledgeBaseFormModalProps) {
  const feedback = useFeedback()
  const create = useCreateKnowledgeBase()
  const update = useUpdateKnowledgeBase()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [chunkSize, setChunkSize] = useState<number | null>(null)
  const [chunkOverlap, setChunkOverlap] = useState<number | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = kb !== null

  // 每次打开都按目标对象重置 —— 否则编辑 A 之后打开"创建"，表单里还留着 A 的内容
  useEffect(() => {
    if (!open) return
    if (kb === null) {
      setName('')
      setDescription('')
      setChunkSize(null)
      setChunkOverlap(null)
    } else {
      const values = editValuesOf(kb)
      setName(values.name)
      setDescription(values.description)
      setChunkSize(values.chunkSize)
      setChunkOverlap(values.chunkOverlap)
    }
    setErrorText(null)
  }, [open, kb])

  const submitting = create.isPending || update.isPending

  /** 两端共用的"能不能提交"：名字必填；两个分块参数**都填了**才判跨字段（见文件头 ①） */
  const chunkingError =
    chunkSize !== null && chunkOverlap !== null ? validateChunking(chunkSize, chunkOverlap) : null
  const canSubmit = name.trim() !== '' && (editing || chunkingError === null) && !submitting

  const submit = (): void => {
    setErrorText(null)

    if (kb === null) {
      const values: KnowledgeCreateFormValues = { name, description, chunkSize, chunkOverlap }
      if (chunkingError !== null) {
        setErrorText(chunkingError)
        return
      }
      create.mutate(buildCreateBody(values), {
        onSuccess: (created) => {
          feedback.ok(`已创建知识库「${created.name}」`)
          onClose()
          onCreated?.(created)
        },
        // 失败停留弹窗：用户需要看到原因（最典型的是 500「服务端 embedding 未就绪」——
        // 建库要快照 `embedding_model`，取不到就建不了。这句话必须让人看见）
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const values: KnowledgeEditFormValues = {
      name,
      description,
      chunkSize: chunkSize ?? kb.chunkSize,
      chunkOverlap: chunkOverlap ?? kb.chunkOverlap,
    }
    const body = buildKnowledgeUpdateBody(kb, values)
    if (body === null) {
      feedback.note('没有需要保存的改动')
      onClose()
      return
    }
    update.mutate(
      { id: kb.id, body },
      {
        onSuccess: (saved) => {
          feedback.ok(`已保存「${saved.name}」`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={editing ? `编辑「${kb.name}」` : '创建知识库'}
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText="取消"
      onOk={submit}
      onCancel={onClose}
      maskClosable={!submitting}
    >
      <div className="stack">
        <div>
          <p className="block-label">名称</p>
          <Input
            value={name}
            maxLength={128}
            aria-label="知识库名称"
            placeholder="例如：运维手册"
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => {
              if (canSubmit) submit()
            }}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            最多 128 个字符。建库是配置动作，不需要先配好模型或 embedding。
          </p>
        </div>

        <div>
          <p className="block-label">描述</p>
          <Input.TextArea
            value={description}
            rows={3}
            maxLength={2000}
            aria-label="知识库描述"
            placeholder="这个库里放什么、给谁用（留空表示不写）"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="block-label">分块字符数</p>
            <InputNumber
              value={chunkSize}
              min={1}
              max={8192}
              style={{ width: '100%' }}
              aria-label="分块字符数"
              placeholder={editing ? undefined : '留空则用服务端默认值'}
              onChange={(value) => setChunkSize(value === null ? null : Number(value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">相邻块重叠字符数</p>
            <InputNumber
              value={chunkOverlap}
              min={0}
              max={8191}
              style={{ width: '100%' }}
              aria-label="相邻块重叠字符数"
              placeholder={editing ? undefined : '留空则用服务端默认值'}
              onChange={(value) => setChunkOverlap(value === null ? null : Number(value))}
            />
          </div>
        </div>

        {/* ⚠️ 别把这两个参数的默认值写死在提示里：它们来自 `infra/.env` 的
            `CHUNK_SIZE_DEFAULT` / `CHUNK_OVERLAP_DEFAULT`，前端**读不到**。
            写一个具体数字会变成一份会与部署配置分叉的说明。（JSX 也不认 Markdown，
            要加粗得用 `<strong>`，见 P0-1-31 的落地要点 4。） */}
        <p className="ratio">
          {editing ? (
            <>
              分块参数改动只影响<strong>之后</strong>入库的内容；已入库的文档要重新上传（覆盖重传）
              才会按新参数重切。
            </>
          ) : (
            <>
              分块参数留空时，服务端会用部署配置里的默认值<strong>快照</strong>到这个库上；
              建库之后仍可单独修改。
            </>
          )}
        </p>

        {chunkingError !== null && <Alert type="warning" showIcon message={chunkingError} />}
        {errorText !== null && (
          <Alert
            type="error"
            showIcon
            message={editing ? '保存失败' : '创建失败'}
            description={errorText}
          />
        )}
      </div>
    </Modal>
  )
}
