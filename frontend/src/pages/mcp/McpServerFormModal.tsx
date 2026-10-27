/**
 * MCP server 注册 / 编辑弹窗（P0-2-11）
 *
 * 依据：`docs/03` §4.4（"注册/编辑弹窗：基本信息 + **凭据参数模板编辑器**（行编辑：
 *      key / label / 注入位置 HEADER·QUERY·BODY）"）、§七（"字段 ≤6 的实体用**弹窗**
 *      （KB、MCP server、用户、模型）"、"同一实体创建与编辑同形态"、"保存语义：显式保存按钮；
 *      失败停留页面"、"键盘约定：Esc 关闭弹窗"）、`design/mcp.html` 的 `#server-modal`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 模板编辑器是**行编辑**，不是"一个 JSON 文本框"
 * ─────────────────────────────────────────────────────────────────────
 * 三列 + 移除按钮（原型 `.tmpl-row` 的 `grid-template-columns: 1fr 1fr 132px auto`）。
 * ⚠️ **注入位置必须是受控下拉**（`06` P0-2-11 坑预判 5）：三个值来自
 * `shared` 的 `CREDENTIAL_INJECT_LOCATIONS`。做成自由文本输入会造出"看着填了 HEADER、
 * 实际是 `header`"这种被后端 400 拦下的错，而 400 的文案（"inject 只能是 HEADER/QUERY/BODY"）
 * 与用户看到的那一行对不上号。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 校验**不在这里重写**，`shared` 那一份就是全部
 * ─────────────────────────────────────────────────────────────────────
 * `mcpModel.ts#templateRowIssues` 直接调 `shared#validateCredentialSchema`
 * （HEADER 名不能撞平台保留头 / QUERY 名不能含 `&=` / BODY 名不能撞 JSON-RPC 保留键 /
 * 同模板内不得重名）。前端自己再写一遍的后果不是"多写几行"，而是**两处判据各自演化**
 * —— 症状是"本地放行、后端 400"，而且文案还长得不一样。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 模板变更的提示在这里**只说事实**，不承诺清理
 * ─────────────────────────────────────────────────────────────────────
 * `PATCH` 响应里的 `credentialSchemaImpact` 由 `mcpModel#credentialImpactHint` 变成一句话，
 * 经 `feedback.note` 给出。⚠️ 措辞里**没有**"已清理"（`06` P0-2-3 坑预判 2：
 * 只提示、绝不自动清理 —— 用户只是临时改错了模板时，「值没了」是不可逆的）。
 */

import { Alert, Button, Input, Modal, Radio, Select } from 'antd'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '../../api/client.js'
import { useCreateMcpServer, usePutMyCredential, useUpdateMcpServer } from '../../api/mcp.js'
import {
  INJECT_LOCATION_KEY,
  INJECT_LOCATIONS,
  SERVER_NAME_MAX,
  appendTemplateRow,
  buildCreateServerBody,
  buildServerUpdateBody,
  canAppendTemplateRow,
  credentialImpactHint,
  emptyServerFormDraft,
  formLevelTemplateIssues,
  keyIssueFor,
  removeTemplateRow,
  serverFormDraftFrom,
  templateRowLimit,
  templateRowIssues,
  updateTemplateRow,
  type ServerFormDraft,
  type TemplateRowDraft,
} from './mcpModel.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import {
  ASSET_VISIBILITY_KEY,
  KB_MCP_VISIBILITIES,
  translate,
  type KbMcpVisibility,
  type McpServerItem,
} from '@doubulea/shared'

export interface McpServerFormModalProps {
  /** `null` = 新建；有值 = 编辑那一条 */
  server: McpServerItem | null
  open: boolean
  onClose: () => void
}

let nextRowSeq = 0
/** 行的稳定 id（React key 与错误定位都用它）。⚠️ 与契约里的 `key` 字段**没有关系** */
function freshRowId(): string {
  nextRowSeq += 1
  return `r${nextRowSeq}`
}

export function McpServerFormModal({ server, open, onClose }: McpServerFormModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const createServer = useCreateMcpServer()
  const updateServer = useUpdateMcpServer()
  // P1-18（2026-10-16 追加）：创建时把创建人填的凭据值默认写入「我的凭据」
  // （与 Provider「各自 Key」创建流程同一口径：创建人建完即已配好，不必再跳一次凭据页）。
  const putCredential = usePutMyCredential()

  const [draft, setDraft] = useState<ServerFormDraft>(emptyServerFormDraft)
  // 可见性单独一份 state（不进 `ServerFormDraft` —— 那两个纯函数被无依赖验收档按旧形状断言）
  const [visibility, setVisibility] = useState<KbMcpVisibility>('PRIVATE')
  /** 创建时创建人为各模板参数填的**自己的**凭据值（`rowId` → 值；仅创建态使用，见文件头 ④） */
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  /** 服务端 400 的字段级错误（`ApiError.fieldMessage` 取不到归属时的兜底展示行） */
  const [formError, setFormError] = useState<string | null>(null)

  // 打开时重置（同一弹窗被"新建 → 编辑 → 新建"复用，不重置会带着上一条的内容）
  useEffect(() => {
    if (!open) return
    setDraft(server === null ? emptyServerFormDraft() : serverFormDraftFrom(server))
    setVisibility(server === null ? 'PRIVATE' : server.visibility)
    setCredentialValues({})
    setNameError(null)
    setUrlError(null)
    setFormError(null)
  }, [open, server])

  const rowIssues = useMemo(
    () => templateRowIssues(draft.credentialSchema, locale),
    [draft.credentialSchema, locale],
  )
  const formIssues = formLevelTemplateIssues(rowIssues)
  /** 创建态可为哪些参数填自己的凭据值（只有 `key` 非空的行才有意义） */
  const credentialValueRows = draft.credentialSchema.filter((row) => row.key.trim() !== '')
  const saving = createServer.isPending || updateServer.isPending || putCredential.isPending

  const setRows = (rows: TemplateRowDraft[]) => {
    setDraft((current) => ({ ...current, credentialSchema: rows }))
  }

  const handleSubmit = async () => {
    setFormError(null)

    // ── 本地校验（与后端同一份 schema；能过这里就一定不会被服务端 400 拦下）──
    const name = draft.name.trim()
    if (name === '') {
      setNameError(t('mcpForm.nameRequired'))
      return
    }
    const endpointUrl = draft.endpointUrl.trim()
    if (endpointUrl === '') {
      setUrlError(t('mcpForm.urlRequired'))
      return
    }
    try {
      const protocol = new URL(endpointUrl).protocol
      if (protocol !== 'http:' && protocol !== 'https:') {
        setUrlError(t('mcpForm.urlScheme'))
        return
      }
    } catch {
      setUrlError(t('mcpForm.urlInvalid'))
      return
    }
    if (rowIssues.length > 0) {
      setFormError(t('mcpForm.templateIssues'))
      return
    }

    try {
      if (server === null) {
        // P1-18：先把创建人为各参数填的**自己的**凭据值收上来（`key` 非空 + 这次真填了值才进提交体）
        const myValues: Record<string, string> = {}
        for (const row of draft.credentialSchema) {
          const value = credentialValues[row.rowId] ?? ''
          if (row.key.trim() !== '' && value.length > 0) myValues[row.key.trim()] = value
        }
        const result = await createServer.mutateAsync(buildCreateServerBody(draft, visibility))
        // P1-18：创建成功后把凭据值写入「我的凭据」（仅创建人可见）。
        // ⚠️ server 已经建出来了 —— 这一步失败**不能**让用户重建成两条（与 Provider「各自 Key」同一处置）。
        if (Object.keys(myValues).length > 0) {
          try {
            await putCredential.mutateAsync({ serverId: result.server.id, values: myValues })
          } catch (error) {
            feedback.fail(error, t('mcpForm.credentialStoreFailed'))
            onClose()
            return
          }
        }
        // ⚠️ `test.ok === false` **不是注册失败**（`06` P0-2-2 定案：注册照常成功，
        // 这次探测只是 best-effort 的一条信息）⇒ 用中性的 note，不用红色的 fail。
        feedback.ok(
          Object.keys(myValues).length > 0
            ? t('mcpForm.registeredWithCred', { name: result.server.name })
            : t('mcpForm.registered', { name: result.server.name }),
        )
        if (result.test.ok) {
          feedback.note(t('mcpForm.handshakeOkNote', { count: result.test.tools.length }))
        } else {
          feedback.note(t('mcpForm.handshakeFailedNote', { error: result.test.error }))
        }
      } else {
        const body = buildServerUpdateBody(server, draft, visibility)
        if (body === null) {
          // 与 §七「保存语义」口径一致：什么也没改 ⇒ 说清楚并**不发请求**
          feedback.note(t('mcpForm.noChanges'))
          onClose()
          return
        }
        const result = await updateServer.mutateAsync({ id: server.id, body })
        feedback.ok(t('mcpForm.saved'))
        const hint = credentialImpactHint(result.credentialSchemaImpact, locale)
        if (hint !== null) feedback.note(hint)
      }
      onClose()
    } catch (error) {
      // 停留弹窗 + 把字段级错误挂回输入框（§七："失败停留页面 + 标注未保存区块，不静默部分成功"）
      if (error instanceof ApiError) {
        setNameError(error.fieldMessage('name') ?? null)
        setUrlError(error.fieldMessage('endpointUrl') ?? null)
        const templateMessage = error.fields.find((issue) =>
          issue.path.startsWith('body.credentialSchema'),
        )?.message
        setFormError(templateMessage ?? null)
      }
      feedback.fail(error, server === null ? t('mcpForm.registerFailed') : t('mcpForm.saveFailed'))
    }
  }

  return (
    <Modal
      open={open}
      title={server === null ? t('mcpForm.titleCreate') : t('mcpForm.titleEdit', { name: server.name })}
      width={720}
      onCancel={onClose}
      // Esc / 点遮罩都走 AntD 默认行为（`03` §七）；只有 `okText` 那一个按钮显式绑提交
      footer={
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSubmit()}>
            {t('common.save')}
          </Button>
        </div>
      }
      destroyOnClose
    >
      <div className="stack stack--tight">
        <div>
          <p className="block-label">{t('mcpForm.name')}</p>
          <Input
            value={draft.name}
            maxLength={SERVER_NAME_MAX}
            status={nameError === null ? undefined : 'error'}
            placeholder={t('mcpForm.namePlaceholder')}
            onChange={(event) => {
              setDraft((current) => ({ ...current, name: event.target.value }))
              setNameError(null)
            }}
          />
          {nameError === null ? (
            <p className="ratio">
              {t('mcpForm.nameHelpPrefix')}
              <code>mcp_&lt;slug&gt;_&lt;tool&gt;</code>
              {t('mcpForm.nameHelpSuffix')}
            </p>
          ) : (
            <p className="ratio" style={{ color: 'var(--danger)' }}>
              {nameError}
            </p>
          )}
        </div>

        <div>
          <p className="block-label">{t('mcpForm.endpoint')}</p>
          <Input
            value={draft.endpointUrl}
            status={urlError === null ? undefined : 'error'}
            aria-label={t('mcpForm.endpointAria')}
            placeholder={t('mcpForm.endpointPlaceholder')}
            onChange={(event) => {
              setDraft((current) => ({ ...current, endpointUrl: event.target.value }))
              setUrlError(null)
            }}
          />
          {urlError === null ? (
            <p className="ratio">{t('mcpForm.endpointHelp')}</p>
          ) : (
            <p className="ratio" style={{ color: 'var(--danger)' }}>
              {urlError}
            </p>
          )}
        </div>

        <div>
          <p className="block-label">{t('mcpForm.visibility')}</p>
          <Radio.Group value={visibility} onChange={(event) => setVisibility(event.target.value as KbMcpVisibility)}>
            {KB_MCP_VISIBILITIES.map((value) => (
              <Radio key={value} value={value}>
                {translate(locale, ASSET_VISIBILITY_KEY[value])}
              </Radio>
            ))}
          </Radio.Group>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {t('mcpForm.visibilityHelp')}
          </p>
        </div>

        <div>
          <p className="block-label">{t('mcpForm.template')}</p>
          <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
            {t('mcpForm.templateHelp')}
          </p>

          <div className="stack stack--tight">
            {draft.credentialSchema.length === 0 ? (
              <p className="ratio">{t('mcpForm.templateEmpty')}</p>
            ) : (
              draft.credentialSchema.map((row, index) => {
                const keyIssue = keyIssueFor(rowIssues, row.rowId)
                return (
                  <div className="tmpl-row" key={row.rowId}>
                    <Input
                      value={row.key}
                      status={keyIssue === undefined ? undefined : 'error'}
                      aria-label={t('mcpForm.rowKeyAria', { n: index + 1 })}
                      placeholder={t('mcpForm.rowKeyPlaceholder')}
                      onChange={(event) =>
                        setRows(updateTemplateRow(draft.credentialSchema, index, { key: event.target.value }))
                      }
                    />
                    <Input
                      value={row.label}
                      aria-label={t('mcpForm.rowLabelAria', { n: index + 1 })}
                      placeholder={t('mcpForm.rowLabelPlaceholder')}
                      onChange={(event) =>
                        setRows(updateTemplateRow(draft.credentialSchema, index, { label: event.target.value }))
                      }
                    />
                    {/* 注入位置：**受控下拉**（坑预判 5），三个值来自 shared 的常量 */}
                    <Select
                      value={row.inject}
                      aria-label={t('mcpForm.rowInjectAria', { n: index + 1 })}
                      options={INJECT_LOCATIONS.map((location) => ({
                        value: location,
                        label: translate(locale, INJECT_LOCATION_KEY[location]),
                      }))}
                      onChange={(value) =>
                        setRows(updateTemplateRow(draft.credentialSchema, index, { inject: value }))
                      }
                    />
                    <Button
                      size="small"
                      danger
                      onClick={() => setRows(removeTemplateRow(draft.credentialSchema, index))}
                    >
                      {t('mcpForm.remove')}
                    </Button>
                    {keyIssue === undefined ? null : (
                      <p className="ratio" style={{ gridColumn: '1 / -1', color: 'var(--danger)' }}>
                        {keyIssue}
                      </p>
                    )}
                  </div>
                )
              })
            )}

            <div className="row" style={{ gap: 'var(--sp-3)' }}>
              <Button
                size="small"
                disabled={!canAppendTemplateRow(draft.credentialSchema)}
                onClick={() => setRows(appendTemplateRow(draft.credentialSchema, freshRowId()))}
              >
                {t('mcpForm.addParam')}
              </Button>
              <span className="ratio">
                {t('mcpForm.limit', { count: draft.credentialSchema.length, max: templateRowLimit() })}
              </span>
            </div>
          </div>

          {formIssues.map((issue, index) => (
            <p className="ratio" key={index} style={{ marginTop: 'var(--sp-2)', color: 'var(--danger)' }}>
              {issue.message}
            </p>
          ))}
        </div>

        {server === null && credentialValueRows.length > 0 && (
          <div>
            <p className="block-label">{t('mcpForm.yourCredential')}</p>
            <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
              {t('mcpForm.yourCredentialHelpPrefix')}
              <strong>{t('mcpForm.yourCredentialHelpStrong')}</strong>
              {t('mcpForm.yourCredentialHelpSuffix')}
            </p>
            <div className="stack stack--tight">
              {credentialValueRows.map((row) => (
                <div key={row.rowId}>
                  <label className="block-label" htmlFor={`create-cred-${row.rowId}`}>
                    {row.label.trim() !== '' ? row.label : row.key}
                    {row.required ? <span title={t('mcpForm.requiredMarkTitle')}> *</span> : null}
                  </label>
                  <Input.Password
                    id={`create-cred-${row.rowId}`}
                    value={credentialValues[row.rowId] ?? ''}
                    autoComplete="off"
                    placeholder={row.placeholder.trim() === '' ? t('mcpForm.fieldPlaceholder', { name: row.key.trim() }) : row.placeholder}
                    onChange={(event) =>
                      setCredentialValues((current) => ({ ...current, [row.rowId]: event.target.value }))
                    }
                  />
                  <p className="ratio" style={{ marginTop: 'var(--sp-1)' }}>
                    {t('mcpForm.fieldMeta', {
                      name: row.key.trim(),
                      inject: translate(locale, INJECT_LOCATION_KEY[row.inject]),
                    })}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {formError === null ? null : <Alert type="error" showIcon message={formError} />}

        {server === null ? (
          <Alert
            type="info"
            showIcon
            message={t('mcpForm.handshakeNoteTitle')}
            description={t('mcpForm.handshakeNoteDesc')}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message={t('mcpForm.impactTitle')}
            description={t('mcpForm.impactDesc')}
          />
        )}
      </div>
    </Modal>
  )
}
