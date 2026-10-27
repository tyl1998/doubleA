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
 * ② 多选 / 空文件 / 真 `.doc` 在**发请求之前**拦下
 * ─────────────────────────────────────────────────────────────────────
 * 判据是纯函数 `screenPickedFiles`（`knowledgeModel.ts`）。三处细节值得点名：
 *   · `accept` 里**故意含 `.doc`**（否则系统文件选择器把它过滤掉，用户根本选不中，
 *     见 `UPLOAD_ACCEPT_ATTRIBUTE`）；
 *   · ⚠️ **P1-12 起 `.doc` 不再只看扩展名**：它可能是 HTML/MIME（MHTML）导出件、本可正常
 *     解析 ⇒ 选中后读**文件头**（`sniffLegacyDocHead` 镜像后端 `detectFormat` 的嗅探），
 *     命中 HTML/MHTML 放行、真 OLE2/RTF 才拦下并给"请另存为 .docx"；
 *   · 用 `beforeUpload` **返回 `false`** 阻止 AntD 自己上传，再拿 `fileList`（完整列表）
 *     判多选 —— 本仓上传端点只接受**一个** `file` 字段，多选不是"排队传"而是 413。
 *
 * ③ 上传成功 ≠ 能检索：响应里的 `status` 恒为 `PARSING`，界面上那一行会是「解析中」
 *    （表格每 2s 自动刷新）。这句提示必须给，否则"传完了搜不到"会被当成 bug。
 */

import { Alert, Button, Checkbox, Modal, Radio, Upload } from 'antd'
import {
  DEFAULT_DOCUMENT_IMAGE_OPTIONS,
  hasAnyImageOption,
  IMAGE_RECOGNITION_KEY,
  IMAGE_RECOGNITIONS,
  IMAGE_VECTORIZE_KEY,
  LEGACY_DOC_EXTENSION,
  UPLOAD_EXTENSIONS,
  translate,
  type DocumentImageOptions,
  type DocumentItem,
  type ImageRecognition,
} from '@doubulea/shared'
import { useEffect, useRef, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useReuploadDocument, useUploadDocument } from '../../api/knowledgeBases.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import {
  LEGACY_DOC_PROBE_BYTES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  extensionOf,
  isImageFile,
  isRecognitionAllowed,
  screenLegacyDocContent,
  screenPickedFiles,
  type FileScreenResult,
  type ImageOptionCapabilities,
} from './knowledgeModel.js'

export interface UploadDocumentModalProps {
  kbId: string
  /** 覆盖重传的目标文档；`null` = 上传一篇新文档 */
  doc: DocumentItem | null
  open: boolean
  onClose: () => void
  /** 该库所选 embedding 模型是否支持多模态（决定「图片向量化」是否可选） */
  multimodalSupported: boolean
  /** 该库是否已选「图片描述模型」（决定「图片含义识别」是否可选） */
  describeSupported: boolean
}

/** 只有 `reject` 这一支会被渲染成提示条 */
type Rejection = Extract<FileScreenResult, { kind: 'reject' }>

export function UploadDocumentModal({
  kbId,
  doc,
  open,
  onClose,
  multimodalSupported,
  describeSupported,
}: UploadDocumentModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const upload = useUploadDocument(kbId)
  const reupload = useReuploadDocument(kbId)

  const [picked, setPicked] = useState<File | null>(null)
  const [options, setOptions] = useState<DocumentImageOptions>(DEFAULT_DOCUMENT_IMAGE_OPTIONS)
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  // `.doc` 的文件头判定是异步的：用户连选两个文件时，只认**最后一次**选择的结果
  const pickSeq = useRef(0)

  const reuploading = doc !== null
  const caps: ImageOptionCapabilities = { multimodalSupported, describeSupported }
  // 用户选了图片文件却既没选识别方式也没开向量化：发送前拦下（后端也会 400，这里省一次往返并当场说清）
  const imageOptionMissing = picked !== null && isImageFile(picked.name) && !hasAnyImageOption(options)

  // 每次打开都清空：上一次选中的文件不能跟着弹窗留到下一次（否则会"上传了两遍"
  // 而用户只记得选过一次）。图片选项默认沿用被重传文档的当前选择。
  useEffect(() => {
    if (!open) return
    setPicked(null)
    setOptions(
      doc === null
        ? DEFAULT_DOCUMENT_IMAGE_OPTIONS
        : { imageRecognize: doc.imageRecognize, imageVectorize: doc.imageVectorize },
    )
    setRejection(null)
    setErrorText(null)
  }, [open, doc])

  const mutating = upload.isPending || reupload.isPending

  const submit = (): void => {
    if (picked === null) return
    setErrorText(null)

    const onError = (error: unknown): void => setErrorText(describeError(error).message)

    if (doc === null) {
      upload.mutate(
        { file: picked, options },
        {
          onSuccess: (result) => {
            feedback.ok(
              result.deduplicated
                ? t('uploadDoc.deduplicated', { name: result.document.fileName })
                : t('uploadDoc.uploaded', { name: result.document.fileName }),
            )
            onClose()
          },
          onError,
        },
      )
      return
    }

    reupload.mutate(
      { docId: doc.id, file: picked, options },
      {
        onSuccess: (result) => {
          feedback.ok(
            result.unchanged
              ? t('uploadDoc.unchanged', { name: result.document.fileName, hint: t('hint.reuploadUnchanged') })
              : t('uploadDoc.reuploaded', { name: result.document.fileName }),
          )
          onClose()
        },
        onError,
      },
    )
  }

  const title = reuploading ? t('uploadDoc.titleReupload', { name: doc.fileName }) : t('uploadDoc.title')

  return (
    <Modal
      open={open}
      title={title}
      width={560}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={mutating}>
          {t('common.cancel')}
        </Button>,
        <Button
          key="ok"
          type="primary"
          loading={mutating}
          disabled={picked === null || rejection !== null || imageOptionMissing}
          onClick={submit}
        >
          {reuploading ? t('uploadDoc.startReupload') : t('uploadDoc.startUpload')}
        </Button>
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
            const seq = pickSeq.current + 1
            pickSeq.current = seq
            const item = fileList[0]

            const result = screenPickedFiles(fileList.map((f) => ({ name: f.name, size: f.size })), locale)
            if (result.kind === 'reject') {
              setRejection(result)
              setPicked(null)
              return false
            }
            setRejection(null)
            setErrorText(null)

            // ⚠️ P1-12：`.doc` 可能是 HTML/MIME 导出件 ⇒ 读文件头判内容（镜像后端嗅探）。
            // 命中 HTML/MHTML 放行；真 OLE2/RTF 拦下并给"请另存为 .docx"。读失败不拦死，
            // 交给后端 `detectFormat` 定夺（它才是权威）。
            if (item && extensionOf(item.name) === LEGACY_DOC_EXTENSION && item.size > 0) {
              setPicked(null)
              void item
                .slice(0, LEGACY_DOC_PROBE_BYTES)
                .arrayBuffer()
                .then((buffer) => {
                  if (pickSeq.current !== seq) return // 已被更晚的一次选择取代
                  const verdict = screenLegacyDocContent(item.name, new Uint8Array(buffer), locale)
                  if (verdict.kind === 'reject') {
                    setRejection(verdict)
                    setPicked(null)
                  } else {
                    setPicked(item)
                  }
                })
                .catch(() => {
                  if (pickSeq.current === seq) setPicked(item)
                })
              return false
            }

            setPicked(item ?? null)
            // 关键：阻止 AntD 自己发上传请求 —— 上传走 api 层（`useUploadDocument`）。
            // 返回 `false` 也让组件**不出现**自己的上传列表（我们只显示自己选的这个文件）。
            return false
          }}
        >
          <p className="empty__title">{t('uploadDoc.dropTitle')}</p>
          <p className="ratio">
            {t('uploadDoc.dropLead', { extensions: UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(' / ') })}
          </p>
        </Upload.Dragger>

        {picked !== null && (
          <p className="ratio">
            {t('uploadDoc.selected', { name: picked.name })}
          </p>
        )}

        <div className="stack stack--tight">
          <p className="ratio">{t('uploadDoc.imageModeLabel')}</p>
          <Radio.Group
            value={options.imageRecognize}
            onChange={(event) =>
              setOptions((previous) => ({ ...previous, imageRecognize: event.target.value as ImageRecognition }))
            }
            options={IMAGE_RECOGNITIONS.map((recognition) => ({
              value: recognition,
              label: translate(locale, IMAGE_RECOGNITION_KEY[recognition]),
              disabled: !isRecognitionAllowed(recognition, caps),
            }))}
          />
          <Checkbox
            checked={options.imageVectorize}
            disabled={!multimodalSupported}
            onChange={(event) =>
              setOptions((previous) => ({ ...previous, imageVectorize: event.target.checked }))
            }
          >
            {translate(locale, IMAGE_VECTORIZE_KEY)}
          </Checkbox>
          <p className="ratio">
            {t('uploadDoc.imageHelp')}
            {!multimodalSupported && t('uploadDoc.noMultimodal')}
            {!describeSupported && t('uploadDoc.noDescribe')}
          </p>
          {imageOptionMissing && (
            <Alert type="warning" showIcon message={t('uploadDoc.imageRequired')} />
          )}
        </div>

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
                <p className="ratio">{t('uploadDoc.blockedNote')}</p>
              </>
            }
          />
        )}

        {reuploading && (
          <Alert
            type="warning"
            showIcon
            message={t('uploadDoc.reuploadWarnTitle')}
            description={t('uploadDoc.reuploadWarnDesc')}
          />
        )}

        {errorText !== null && (
          <Alert
            type="error"
            showIcon
            message={reuploading ? t('uploadDoc.failedReupload') : t('uploadDoc.failedUpload')}
            description={errorText}
          />
        )}

        <p className="ratio">
          {t('uploadDoc.sizeNote')}
        </p>
      </div>
    </Modal>
  )
}
