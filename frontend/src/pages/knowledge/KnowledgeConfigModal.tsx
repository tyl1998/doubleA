/**
 * 检索配置弹窗（P0-1-35）
 *
 * 依据：`docs/03` §4.3（详情页的"名称/描述/**检索配置**编辑"）、`shared/src/knowledgeBase.ts`
 *      （`retrievalConfig` 的六个键、`.max()` 上限与"局部合并"语义）、`docs/02` §4.6 的
 *      「参数来源」行。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 原型的口径是**反的**，这里必须按契约来
 * ─────────────────────────────────────────────────────────────────────
 * `design/knowledge.html` 的「检索配置」卡上挂着一个 tag：**"不落库 · 每次请求传入"**，
 * 卡里还有 mode / topK / 分块字符数三个字段 + 「保存配置」按钮。那段话描述的是
 * **「检索测试」抽屉**的参数（那次请求的 `mode`/`topK` 可以覆盖、且不落库），
 * 却被贴到了库级配置卡上。
 *
 * 实际情况（`docs/02` §4.6「参数来源」）：
 *   · `mode` / `topK` / `score` / `rrfK` / `weights` / `splitStrategy` ← **该库的快照**，
 *     建库时来自环境默认值，此后**按库独立可改**（改它就是要落库的，别的调用方也会受影响）；
 *   · 只有 `candidatePool` 来自环境级配置，前端不展示。
 * 若照抄那句 tag，用户会以为"这个页面上的配置不影响检索"——而它恰恰是**唯一**能改库级
 * 口径的地方（`06` §六 第 ④ 条：原型的视觉照做、**数值与口径一律以契约为准**）。
 *
 * 两个"不能合并展示"的地方：
 *   · `score` **只作用于向量路**（`bigm_similarity` 与 cosine 量纲不可比）—— 标签上要写清，
 *     否则用户会以为它是"总分的下限"，从而把全文路的结果也一起卡掉；
 *   · 未命中一路时 `—` 与 `0` 的区别属检索测试抽屉（见 `knowledgeModel.searchNotice`），
 *     这里只负责把"下限"这个语义说准。
 */

import { Alert, InputNumber, Modal, Select } from 'antd'
import {
  RETRIEVAL_MODES,
  SPLIT_STRATEGIES,
  retrievalConfigInputSchema,
  type KnowledgeBaseItem,
} from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useUpdateKnowledgeBase } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import {
  RETRIEVAL_MODE_LABEL,
  SPLIT_STRATEGY_LABEL,
  buildRetrievalPatch,
  retrievalValuesOf,
  type RetrievalFormValues,
} from './knowledgeModel.js'

export interface KnowledgeConfigModalProps {
  /** 要改配置的库；`null` = 弹窗关闭 */
  kb: KnowledgeBaseItem | null
  open: boolean
  onClose: () => void
}

export function KnowledgeConfigModal({ kb, open, onClose }: KnowledgeConfigModalProps) {
  const feedback = useFeedback()
  const update = useUpdateKnowledgeBase()
  const [values, setValues] = useState<RetrievalFormValues | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open || kb === null) return
    setValues(retrievalValuesOf(kb))
    setErrorText(null)
  }, [open, kb])

  if (kb === null || values === null) return null

  const patch = (next: Partial<RetrievalFormValues>): void => {
    setValues((current) => (current === null ? current : { ...current, ...next }))
    setErrorText(null)
  }

  const submitting = update.isPending
  const submit = (): void => {
    const body = buildRetrievalPatch(kb, values)
    if (body === null) {
      feedback.note('没有需要保存的改动')
      onClose()
      return
    }
    // ⚠️ 提交前用 `shared` 的 schema 跑一遍（`03` §一 的纪律：前端不让填的、后端也不会过）。
    // 这里能抓到的是"数字超出上限"这类单个字段的问题；跨字段的（chunkOverlap < chunkSize）
    // 归 `validateChunking` 与后端。
    const parsed = retrievalConfigInputSchema.safeParse(body.retrievalConfig)
    if (!parsed.success) {
      setErrorText(parsed.error.issues.map((issue) => issue.message).join(' · '))
      return
    }

    update.mutate(
      { id: kb.id, body },
      {
        onSuccess: (saved) => {
          feedback.ok(`已保存「${saved.name}」的检索配置`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          检索配置「{kb.name}」
        </span>
      }
      okText="保存"
      okButtonProps={{ loading: submitting }}
      cancelText="取消"
      onOk={submit}
      onCancel={onClose}
      maskClosable={!submitting}
      width={560}
    >
      <div className="stack">
        <Alert
          type="info"
          showIcon
          message="这些是这个知识库的口径（会落库）"
          description="保存后对所有检索生效，包括智能体对话时的检索。「检索测试」里的 mode / topK 是那一次试查的临时覆盖，不会改动这里。"
        />

        <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="block-label">检索模式</p>
            <Select
              value={values.mode}
              style={{ width: '100%' }}
              aria-label="检索模式"
              onChange={(mode) => patch({ mode })}
              options={RETRIEVAL_MODES.map((mode) => ({ value: mode, label: RETRIEVAL_MODE_LABEL[mode] }))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">分块策略</p>
            <Select
              value={values.splitStrategy}
              style={{ width: '100%' }}
              aria-label="分块策略"
              onChange={(splitStrategy) => patch({ splitStrategy })}
              options={SPLIT_STRATEGIES.map((strategy) => ({
                value: strategy,
                label: SPLIT_STRATEGY_LABEL[strategy],
              }))}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="block-label">返回条数 topK</p>
            <InputNumber
              value={values.topK}
              min={1}
              max={100}
              style={{ width: '100%' }}
              aria-label="返回条数 topK"
              onChange={(value) => patch({ topK: Number(value ?? 1) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">向量路相似度下限</p>
            <InputNumber
              value={values.score}
              min={0}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              aria-label="向量路相似度下限"
              onChange={(value) => patch({ score: Number(value ?? 0) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">RRF 平滑常数 k</p>
            <InputNumber
              value={values.rrfK}
              min={1}
              max={1000}
              style={{ width: '100%' }}
              aria-label="RRF 平滑常数"
              onChange={(value) => patch({ rrfK: Number(value ?? 1) })}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="block-label">向量路权重</p>
            <InputNumber
              value={values.vectorWeight}
              min={0}
              max={100}
              step={0.1}
              style={{ width: '100%' }}
              aria-label="向量路权重"
              onChange={(value) => patch({ vectorWeight: Number(value ?? 0) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p className="block-label">全文路权重</p>
            <InputNumber
              value={values.fulltextWeight}
              min={0}
              max={100}
              step={0.1}
              style={{ width: '100%' }}
              aria-label="全文路权重"
              onChange={(value) => patch({ fulltextWeight: Number(value ?? 0) })}
            />
          </div>
        </div>

        <p className="ratio">
          「相似度下限」<strong>只作用于向量路</strong>（cosine）：全文路的分是
          <code>bigm_similarity</code>，两者量纲不可比，用同一个阈值卡会把全文路的结果一起误杀。
          两个权重按 RRF 公式 <code>w/(k+rank)</code> 相加，缺失的一路记为无贡献。
        </p>

        {errorText !== null && <Alert type="error" showIcon message="保存失败" description={errorText} />}
      </div>
    </Modal>
  )
}
