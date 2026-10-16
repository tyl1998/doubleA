/**
 * 文档表格（P0-1-35）
 *
 * 依据：`docs/03` §4.3（"文档表格：文件名 / 状态（解析中 spinner、完成 ✓、失败 ✗+原因）/
 *      chunk 数 / 更新时间 / 操作（覆盖重传、重试、下载原始文件、删除）"）、§七（**表格规范**：
 *      操作列固定右侧、文字链按钮、危险操作红色、删除放最后；**删除分级**：文档删除走
 *      Popconfirm）、`shared/src/document.ts`（三态与两条界面规则）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 四列读数各自的"能不能显示"都查过一遍
 * ─────────────────────────────────────────────────────────────────────
 * | 列 | 数据源 | 不可用时怎么办 |
 * |----|--------|---------------|
 * | 文件名 | `fileName` | —— |
 * | 状态 | `status` + `errorMsg` | `FAILED` 才有原因；`PARSING` 挂 `DOCUMENT_PARSING_HINT` |
 * | 片段数 | `chunkCount` | 非 `READY` 显示 `—`（**不显示 0**，见 `chunkCountText`） |
 * | 更新时间 | `updatedAt` | —— |
 * ⚠️ **原型上的"1.2 MB · md"里的 `1.2 MB` 这里没有**：`documentItemSchema` **不含文件大小**
 * （列里也没存）。写一个数字上去就是造假，所以副标题只放扩展名（`documentExtensionLabel`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 行内操作按状态显隐（`documentActions`），不是"都给上、让后端拒"
 * ─────────────────────────────────────────────────────────────────────
 * 最典型的是「重试」：`READY` 的文档点它必然 409（"没有东西可重试"），而 `PARSING` 的文档
 * 恰恰**需要**它（worker 崩了时的恢复入口，后端刻意放行）。所以判据不能是"完成的不给、
 * 其他都给"这么随手写 —— 完整矩阵与理由都在 `documentActions` 上，验收档逐格断言。
 */

import { Button, Input, Modal, Popconfirm, Table, Tooltip, type TableColumnsType } from 'antd'
import {
  describeImageOptions,
  hasAnyImageOption,
  KNOWLEDGE_BASE_NEEDS_REBUILD_HINT,
  isDocumentSearchable,
  type DocumentItem,
} from '@doubulea/shared'
import { useState } from 'react'

import { saveDocumentFile, useRemoveDocument, useRenameDocument, useRetryDocument } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { formatUpdatedAt } from '../../app/format.js'
import {
  DOCUMENT_STATUS_META,
  chunkCountText,
  documentActions,
  documentExtensionLabel,
} from './knowledgeModel.js'

export interface DocumentTableProps {
  kbId: string
  documents: readonly DocumentItem[]
  /**
   * 该库处于"需整库重建"状态（`needsRebuild`）：此时**重试 / 覆盖重传**会被后端 409
   * （单篇入库会写成混合维度）⇒ 这里直接禁用并说明，别让用户点了才被拒。
   */
  rebuildRequired?: boolean
  /** 打开「覆盖重传」弹窗（弹窗由页面持有，表格只发意图） */
  onReupload: (doc: DocumentItem) => void
  /** 打开「片段预览」抽屉（同上，抽屉由页面持有） */
  onPreviewChunks: (doc: DocumentItem) => void
}

export function DocumentTable({ kbId, documents, rebuildRequired = false, onReupload, onPreviewChunks }: DocumentTableProps) {
  const feedback = useFeedback()
  const retry = useRetryDocument(kbId)
  const remove = useRemoveDocument(kbId)
  const rename = useRenameDocument(kbId)

  /** 重命名弹窗（2026-10-16）：只改展示名，不碰内容 —— 任意状态都可改 */
  const [renameTarget, setRenameTarget] = useState<DocumentItem | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const openRename = (doc: DocumentItem): void => {
    setRenameTarget(doc)
    setRenameValue(doc.fileName)
  }

  const submitRename = (): void => {
    if (renameTarget === null) return
    const fileName = renameValue.trim()
    if (fileName === '') {
      feedback.note('文件名不能为空')
      return
    }
    if (fileName === renameTarget.fileName) {
      setRenameTarget(null)
      return
    }
    rename.mutate(
      { docId: renameTarget.id, fileName },
      {
        onSuccess: (updated) => {
          feedback.ok(`已重命名为「${updated.fileName}」`)
          setRenameTarget(null)
        },
        // 最可能是 400（改了扩展名）：服务端文案本身可以照做，只补一个标题
        onError: (error) => feedback.fail(error, '重命名失败'),
      },
    )
  }

  const download = (doc: DocumentItem): void => {
    void saveDocumentFile(kbId, doc).catch((error: unknown) => {
      // 下载失败**必须**给通知：它是唯一一个"点了之后浏览器没动静"的操作
      // （成功时浏览器自己弹下载栏，失败时什么都不发生 —— 不说就等于没反应）
      feedback.fail(error, '下载失败')
    })
  }

  const doRetry = (doc: DocumentItem): void => {
    retry.mutate(doc.id, {
      onSuccess: (result) => {
        feedback.ok(`已重新入队「${result.document.fileName}」，稍候查看状态`)
      },
      onError: (error) => {
        // 最可能是 409（状态已经变了：比如刚好解析完成 ⇒ 没有东西可重试）。
        // 服务端文案本身可以照做，所以只补一个标题。
        feedback.fail(error, '重试失败')
      },
    })
  }

  const doRemove = (doc: DocumentItem): void => {
    remove.mutate(doc.id, {
      onSuccess: (result) => {
        feedback.ok(`已删除「${result.fileName}」及其 ${result.deletedChunks} 个片段`)
      },
      onError: (error) => feedback.fail(error, '删除失败'),
    })
  }

  const columns: TableColumnsType<DocumentItem> = [
    {
      title: '文件名',
      dataIndex: 'fileName',
      render: (_, doc) => (
        <div className="kb-cell">
          <span className="kb-cell__name">{doc.fileName}</span>
          <span className="kb-cell__sub num">
            {documentExtensionLabel(doc.fileName)}
            {/* 勾了图片选项时补一个标记（全关不显示，避免满屏噪音） */}
            {hasAnyImageOption(doc) && ` · ${describeImageOptions(doc)}`}
          </span>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 220,
      render: (_, doc) => {
        const meta = DOCUMENT_STATUS_META[doc.status]
        return (
          <div className="kb-cell">
            {/* 状态灯 + 文案两重表达：只靠颜色在色觉障碍与暗色主题下读不出状态 */}
            <span className="row" style={{ gap: 'var(--sp-2)' }}>
              <span className={`led led--${meta.led}`} aria-hidden="true" />
              <span>{meta.label}</span>
            </span>
            {/* 失败原因来自 `errorMsg`（后端写好的中文，如"疑似扫描件"）；
                解析中挂的是 `shared` 的那句"更新中，暂不参与检索" */}
            {doc.status === 'FAILED' && doc.errorMsg !== null && (
              <span className="kb-cell__sub">{doc.errorMsg}</span>
            )}
            {meta.hint !== null && <span className="kb-cell__sub">{meta.hint}</span>}
          </div>
        )
      },
    },
    {
      title: '片段数',
      dataIndex: 'chunkCount',
      width: 90,
      align: 'right',
      render: (_, doc) => <span className="num">{chunkCountText(doc)}</span>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, doc) => <span className="num">{formatUpdatedAt(doc.updatedAt)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 320,
      align: 'right',
      render: (_, doc) => {
        const actions = documentActions(doc.status)
        return (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
            {actions.canPreviewChunks && (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onPreviewChunks(doc)}>
                查看片段
              </Button>
            )}
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => download(doc)}>
              下载
            </Button>
            {/* 重命名（2026-10-16）：只改展示名，任意状态都可用（不碰内容/chunk/入队） */}
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openRename(doc)}>
              重命名
            </Button>
            {actions.canReupload && (
              <Tooltip title={rebuildRequired ? KNOWLEDGE_BASE_NEEDS_REBUILD_HINT : undefined}>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  disabled={rebuildRequired}
                  onClick={() => onReupload(doc)}
                >
                  覆盖重传
                </Button>
              </Tooltip>
            )}
            {actions.canRetry && (
              <Tooltip title={rebuildRequired ? KNOWLEDGE_BASE_NEEDS_REBUILD_HINT : actions.retryHint}>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  disabled={rebuildRequired}
                  loading={retry.isPending && retry.variables === doc.id}
                  onClick={() => doRetry(doc)}
                >
                  重试
                </Button>
              </Tooltip>
            )}
            {/* 删除放最后（§七 的表格规范）；文档删除是**普通删除**那一档 ⇒ Popconfirm */}
            <Popconfirm
              title={`删除「${doc.fileName}」？`}
              description={
                isDocumentSearchable(doc.status)
                  ? `该文档的 ${doc.chunkCount} 个片段与向量会一并移除，引用它的智能体将检索不到这些内容。`
                  : '这篇文档尚未就绪，删除会移除它的记录与原始文件。'
              }
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => doRemove(doc)}
            >
              <Button
                type="link"
                size="small"
                danger
                style={{ padding: 0 }}
                disabled={remove.isPending && remove.variables === doc.id}
              >
                删除
              </Button>
            </Popconfirm>
          </div>
        )
      },
    },
  ]

  return (
    <>
      <Table<DocumentItem>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={[...documents]}
        // 加载态由页面的骨架屏承担（`ListStates`），这里不再叠一层 AntD 遮罩转圈
        loading={false}
        pagination={
          documents.length > 20 ? { pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 篇` } : false
        }
        locale={{ emptyText: '还没有文档' }}
        scroll={{ x: 900 }}
      />

      {/* 重命名弹窗（2026-10-16）：整表一个，`renameTarget` 决定打开与目标 */}
      <Modal
        open={renameTarget !== null}
        title={`重命名「${renameTarget?.fileName ?? ''}」`}
        okText="保存"
        cancelText="取消"
        confirmLoading={rename.isPending}
        maskClosable={!rename.isPending}
        okButtonProps={{ disabled: renameValue.trim() === '' }}
        onOk={submitRename}
        onCancel={() => setRenameTarget(null)}
      >
        <p className="block-label">文件名</p>
        <Input
          value={renameValue}
          maxLength={255}
          aria-label="文档文件名"
          placeholder="新的文件名（扩展名保持不变）"
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={submitRename}
        />
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          只改展示名 —— 文档内容与已入库的片段不变，也不会重新解析。扩展名要与原来一致
          （如 <code>.pdf</code>），否则下载 / 预览的类型会对不上，服务端会拒绝。
        </p>
      </Modal>
    </>
  )
}
