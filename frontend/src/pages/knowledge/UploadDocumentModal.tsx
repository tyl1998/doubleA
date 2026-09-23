/**
 * 上传文档 / 覆盖重传弹窗（P0-1-35）
 *
 * 依据：`docs/03` §4.3（"上传文档"与文档表格里的"覆盖重传"）、`design/knowledge.html` 的
 *      `#upload-modal`（拖拽区 + 白名单提示 + "同名文件视为覆盖重传"）、`shared/src/document.ts`
 *      （四道前置校验、`UPLOAD_FILE_FIELD`、`REUPLOAD_UNCHANGED_HINT`）、`docs/02` §4.6
 *      （上传只登记 + 入队，真正的解析由 worker 异步完成）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 两种形态共用一个组件（上传新文档 / 覆盖重传某篇）
 * ─────────────────────────────────────────────────────────────────────
 * 它们的请求形态**逐字相同**（`multipart`、同一个字段名、同一段前置校验），差别只有路径与
 * 响应里那个布尔的名字（`deduplicated` / `unchanged`）。分成两个组件必然出现"重建漏了某条
 * 前端校验" —— 后端为此专门共用了 `readUploadedFile`（"重建不能成为绕开校验的后门"），
 * 前端也照同一个思路做。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② `.doc` / 多选 / 空文件在**发请求之前**拦下（验收原文："选 .doc 立即提示且不发请求"）
 * ─────────────────────────────────────────────────────────────────────
 * 判据是纯函数 `screenPickedFiles`（`knowledgeModel.ts`）。两处细节值得点名：
 *   · `accept` 里**故意含 `.doc`**（否则系统文件选择器把它过滤掉，用户根本选不中，
 *     那句"请另存为 .docx 后重传"永远不会出现，见 `UPLOAD_ACCEPT_ATTRIBUTE`）；
 *   · 用 `beforeUpload` **返回 `false`** 阻止 AntD 自己上传，再拿 `fileList`（完整列表）
 *     判多选 —— 本仓上传端点只接受**一个** `file` 字段，多选不是"排队传"而是 413。
 *
 * ③ 上传成功 ≠ 能检索：响应里的 `status` 恒为 `PARSING`，界面上那一行会是「解析中」
 *    （表格每 2s 自动刷新）。这句提示必须给，否则"传完了搜不到"会被当成 bug。
 */

import { Alert, Button, Modal, Upload } from 'antd'
import { REUPLOAD_UNCHANGED_HINT, UPLOAD_EXTENSIONS, type DocumentItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useReuploadDocument, useUploadDocument } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { UPLOAD_ACCEPT_ATTRIBUTE, screenPickedFiles, type FileScreenResult } from './knowledgeModel.js'

export interface UploadDocumentModalProps {
  kbId: string
  /** 覆盖重传的目标文档；`null` = 上传一篇新文档 */
  doc: DocumentItem | null
  open: boolean
  onClose: () => void
}

/** 只有 `reject` 这一支会被渲染成提示条 */
type Rejection = Extract<FileScreenResult, { kind: 'reject' }>

export function UploadDocumentModal({ kbId, doc, open, onClose }: UploadDocumentModalProps) {
  const feedback = useFeedback()
  const upload = useUploadDocument(kbId)
  const reupload = useReuploadDocument(kbId)

  const [picked, setPicked] = useState<File | null>(null)
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const reuploading = doc !== null

  // 每次打开都清空：上一次选中的文件不能跟着弹窗留到下一次（否则会"上传了两遍"
  // 而用户只记得选过一次）
  useEffect(() => {
    if (!open) return
    setPicked(null)
    setRejection(null)
    setErrorText(null)
  }, [open, doc])

  const mutating = upload.isPending || reupload.isPending

  const submit = (): void => {
    if (picked === null) return
    setErrorText(null)

    const onError = (error: unknown): void => setErrorText(describeError(error).message)

    if (doc === null) {
      upload.mutate(picked, {
        onSuccess: (result) => {
          feedback.ok(
            result.deduplicated
              ? `该库里已有内容完全相同的文档，未新建记录（沿用「${result.document.fileName}」）`
              : `已上传「${result.document.fileName}」并加入解析队列`,
          )
          onClose()
        },
        onError,
      })
      return
    }

    reupload.mutate(
      { docId: doc.id, file: picked },
      {
        onSuccess: (result) => {
          feedback.ok(
            result.unchanged
              ? `「${result.document.fileName}」${REUPLOAD_UNCHANGED_HINT}`
              : `已覆盖重传「${result.document.fileName}」并加入解析队列`,
          )
          onClose()
        },
        onError,
      },
    )
  }

  const title = reuploading ? `覆盖重传「${doc.fileName}」` : '上传文档'

  return (
    <Modal
      open={open}
      title={title}
      width={560}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={mutating}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          loading={mutating}
          disabled={picked === null || rejection !== null}
          onClick={submit}
        >
          {reuploading ? '开始重传' : '开始上传'}
        </Button>,
      ]}
      onCancel={onClose}
      maskClosable={!mutating}
    >
      <div className="stack">
        <Upload.Dragger
          // ⚠️ 故意允许"看起来多选"：由 `screenPickedFiles` 把多选拒掉并说明原因
          // （只设 `multiple={false}` 的话，用户拖两个文件进来时我们**什么都收不到**，
          //  界面表现为"拖了没反应"——那是比 413 更难查的一种）
          multiple
          maxCount={1}
          showUploadList={false}
          accept={UPLOAD_ACCEPT_ATTRIBUTE}
          beforeUpload={(_file, fileList) => {
            const result = screenPickedFiles(fileList.map((item) => ({ name: item.name, size: item.size })))
            if (result.kind === 'reject') {
              setRejection(result)
              setPicked(null)
            } else {
              setRejection(null)
              setErrorText(null)
              setPicked(fileList[0] ?? null)
            }
            // 关键：阻止 AntD 自己发上传请求 —— 上传走 api 层（`useUploadDocument`）。
            // 返回 `false` 也让组件**不出现**自己的上传列表（我们只显示自己选的这个文件）。
            return false
          }}
        >
          <p className="empty__title">把文件拖到这里</p>
          <p className="ratio">
            支持 {UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(' / ')}；
            一次一个文件。上传后文档进入「解析中」，由后台流水线异步解析与分块。
          </p>
        </Upload.Dragger>

        {picked !== null && (
          <p className="ratio">
            已选择：<span className="num">{picked.name}</span>
          </p>
        )}

        {rejection !== null && (
          <Alert
            type="warning"
            showIcon
            message={rejection.message}
            description={
              <>
                {rejection.hint !== null && <p>{rejection.hint}</p>}
                {/* 验收原文要的是"立即提示**且不发请求**"——那就把这件事说出来，
                    否则用户无从判断这次点击到底有没有惊动服务端 */}
                <p className="ratio">文件已被前端拦下，没有发起上传请求。</p>
              </>
            }
          />
        )}

        {reuploading && (
          <Alert
            type="warning"
            showIcon
            message="覆盖重传会换掉这一篇的内容"
            description="旧片段先删后建：期间这篇文档不可检索（列表里显示「更新中，暂不参与检索」）。文档 id 与创建时间不变，引用它的智能体不需要改配置。"
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={reuploading ? '重传失败' : '上传失败'} description={errorText} />
        )}

        <p className="ratio">
          单文件大小上限由服务端配置决定（超出会返回 413）；扫描件会在解析阶段判为失败并给出原因。
        </p>
      </div>
    </Modal>
  )
}
