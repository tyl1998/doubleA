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
  INJECT_LOCATION_LABEL,
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
import {
  ASSET_VISIBILITY_LABELS,
  KB_MCP_VISIBILITIES,
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

  const rowIssues = useMemo(() => templateRowIssues(draft.credentialSchema), [draft.credentialSchema])
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
      setNameError('请输入 MCP server 名称')
      return
    }
    const endpointUrl = draft.endpointUrl.trim()
    if (endpointUrl === '') {
      setUrlError('请填写 endpoint URL')
      return
    }
    try {
      const protocol = new URL(endpointUrl).protocol
      if (protocol !== 'http:' && protocol !== 'https:') {
        setUrlError('endpoint URL 只支持 http / https（Streamable HTTP）')
        return
      }
    } catch {
      setUrlError('endpoint URL 不是合法的 URL')
      return
    }
    if (rowIssues.length > 0) {
      setFormError('凭据参数模板里还有问题：先修掉下面标红的那几行。')
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
            feedback.fail(error, 'server 已注册，但你的凭据没能存入「我的凭据」')
            onClose()
            return
          }
        }
        // ⚠️ `test.ok === false` **不是注册失败**（`06` P0-2-2 定案：注册照常成功，
        // 这次探测只是 best-effort 的一条信息）⇒ 用中性的 note，不用红色的 fail。
        feedback.ok(
          Object.keys(myValues).length > 0
            ? `已注册 server「${result.server.name}」，并把凭据存入了「我的凭据」`
            : `已注册 server「${result.server.name}」`,
        )
        if (result.test.ok) {
          feedback.note(`顺带握手成功：拿到 ${result.test.tools.length} 个工具。`)
        } else {
          feedback.note(`顺带握手失败：${result.test.error}（不影响注册，可稍后点「测试」重试）`)
        }
      } else {
        const body = buildServerUpdateBody(server, draft, visibility)
        if (body === null) {
          // 与 §七「保存语义」口径一致：什么也没改 ⇒ 说清楚并**不发请求**
          feedback.note('没有需要保存的改动')
          onClose()
          return
        }
        const result = await updateServer.mutateAsync({ id: server.id, body })
        feedback.ok('已保存')
        const hint = credentialImpactHint(result.credentialSchemaImpact)
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
      feedback.fail(error, server === null ? '注册失败' : '保存失败')
    }
  }

  return (
    <Modal
      open={open}
      title={server === null ? '注册 MCP server' : `编辑 server「${server.name}」`}
      width={720}
      onCancel={onClose}
      // Esc / 点遮罩都走 AntD 默认行为（`03` §七）；只有 `okText` 那一个按钮显式绑提交
      footer={
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSubmit()}>
            保存
          </Button>
        </div>
      }
      destroyOnClose
    >
      <div className="stack stack--tight">
        <div>
          <p className="block-label">名称</p>
          <Input
            value={draft.name}
            maxLength={SERVER_NAME_MAX}
            status={nameError === null ? undefined : 'error'}
            placeholder="例如：git"
            onChange={(event) => {
              setDraft((current) => ({ ...current, name: event.target.value }))
              setNameError(null)
            }}
          />
          {nameError === null ? (
            <p className="ratio">工具名会以它派生出的 slug 作前缀（`mcp_&lt;slug&gt;_&lt;tool&gt;`），创建后不可修改。</p>
          ) : (
            <p className="ratio" style={{ color: 'var(--danger)' }}>
              {nameError}
            </p>
          )}
        </div>

        <div>
          <p className="block-label">endpoint URL</p>
          <Input
            value={draft.endpointUrl}
            status={urlError === null ? undefined : 'error'}
            placeholder="https://mcp.internal/git"
            onChange={(event) => {
              setDraft((current) => ({ ...current, endpointUrl: event.target.value }))
              setUrlError(null)
            }}
          />
          {urlError === null ? (
            <p className="ratio">
              Streamable HTTP 的单一 URL（不是 baseUrl + 路径拼接）。保存后列表状态会标为「未测试」，
              点「测试」会真连一次。
            </p>
          ) : (
            <p className="ratio" style={{ color: 'var(--danger)' }}>
              {urlError}
            </p>
          )}
        </div>

        <div>
          <p className="block-label">可见性</p>
          <Radio.Group value={visibility} onChange={(event) => setVisibility(event.target.value as KbMcpVisibility)}>
            {KB_MCP_VISIBILITIES.map((value) => (
              <Radio key={value} value={value}>
                {ASSET_VISIBILITY_LABELS[value]}
              </Radio>
            ))}
          </Radio.Group>
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            公开 = 全员可看可用、可被公开的智能体绑定；私有 = 仅所属人（你）与管理员可见。
            转移所属人后，连通测试与工具列表会用新所属人的凭据。
          </p>
        </div>

        <div>
          <p className="block-label">凭据参数模板</p>
          <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
            模板决定「我的凭据」页出现哪些输入项，以及它们注入到请求的哪个位置（HEADER / QUERY / BODY）。
            留空表示这台 server 不需要用户填任何东西。
          </p>

          <div className="stack stack--tight">
            {draft.credentialSchema.length === 0 ? (
              <p className="ratio">还没有任何参数 —— 保存后「我的凭据」会把这台 server 显示成「无需凭据」。</p>
            ) : (
              draft.credentialSchema.map((row, index) => {
                const keyIssue = keyIssueFor(rowIssues, row.rowId)
                return (
                  <div className="tmpl-row" key={row.rowId}>
                    <Input
                      value={row.key}
                      status={keyIssue === undefined ? undefined : 'error'}
                      aria-label={`第 ${index + 1} 行参数名`}
                      placeholder="参数名，例如 Authorization"
                      onChange={(event) =>
                        setRows(updateTemplateRow(draft.credentialSchema, index, { key: event.target.value }))
                      }
                    />
                    <Input
                      value={row.label}
                      aria-label={`第 ${index + 1} 行说明`}
                      placeholder="给填值的人看的说明"
                      onChange={(event) =>
                        setRows(updateTemplateRow(draft.credentialSchema, index, { label: event.target.value }))
                      }
                    />
                    {/* 注入位置：**受控下拉**（坑预判 5），三个值来自 shared 的常量 */}
                    <Select
                      value={row.inject}
                      aria-label={`第 ${index + 1} 行注入位置`}
                      options={INJECT_LOCATIONS.map((location) => ({
                        value: location,
                        label: INJECT_LOCATION_LABEL[location],
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
                      移除
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
                + 添加参数
              </Button>
              <span className="ratio">
                已 {draft.credentialSchema.length} / 上限 {templateRowLimit()} 个 · 同一模板内参数名不得重复
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
            <p className="block-label">你的凭据（可选）</p>
            <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
              这里填的值会随注册一起写入「我的凭据」—— 也就是<strong>代表你调用该工具</strong>用的那一份，
              仅你可见。留空表示稍后到「我的凭据」页再填（连所属人以外的使用者也要各自填自己的）。
            </p>
            <div className="stack stack--tight">
              {credentialValueRows.map((row) => (
                <div key={row.rowId}>
                  <label className="block-label" htmlFor={`create-cred-${row.rowId}`}>
                    {row.label.trim() !== '' ? row.label : row.key}
                    {row.required ? <span title="必填"> *</span> : null}
                  </label>
                  <Input.Password
                    id={`create-cred-${row.rowId}`}
                    value={credentialValues[row.rowId] ?? ''}
                    autoComplete="off"
                    placeholder={row.placeholder.trim() === '' ? `参数 ${row.key.trim()}` : row.placeholder}
                    onChange={(event) =>
                      setCredentialValues((current) => ({ ...current, [row.rowId]: event.target.value }))
                    }
                  />
                  <p className="ratio" style={{ marginTop: 'var(--sp-1)' }}>
                    参数名 <code>{row.key.trim()}</code> · 注入位置{' '}
                    {INJECT_LOCATION_LABEL[row.inject]}
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
            message="注册不要求上游可达"
            description="保存时会握手一次：握手失败不影响注册成功，只是列表上那个状态会显示「握手失败」，可以稍后点「测试」重试。"
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="改动模板会影响已填的凭据（但不会被自动清理）"
            description="删除或改名一个已被填过的参数，那些值将不再被注入，但会原样留在库里 —— 保存后若有影响，这里会给出具体清单，需要清理请到「我的凭据」里自行操作。"
          />
        )}
      </div>
    </Modal>
  )
}
