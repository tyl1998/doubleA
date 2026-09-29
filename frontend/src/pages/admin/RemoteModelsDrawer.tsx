/**
 * 拉取上游模型列表（抽屉，P0-1-36；端点本身是 P0-1-12 就绪的）
 *
 * 依据：`docs/02` §4.3「契约增量 · 拉取上游模型列表」、`shared/src/modelProvider.ts`
 *      （`RemoteModelListResult`）、`docs/03` §七（抽屉、Esc 关闭、列表三态）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它解决的具体问题：型号名靠手敲，敲错一个字符要等到第一次发消息才以 404 暴露
 * ─────────────────────────────────────────────────────────────────────
 * 这是"OpenAI 兼容实现基本都提供"的 `GET {baseUrl}/models`，把上游**真实**的型号列出来，
 * 由管理员自己挑。**刻意不做自动增删**（`01` §3.2 没要求）：上游清单里常混着一堆不能用的
 * （embedding、图像、老版本……），自动灌进来会造出一批"选得到、用不了"的模型。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三处如实口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **只读探测、不落库**：探完这个 Provider 下的模型条数**一条都没变**（`02` §4.3 有断言守着）。
 *    所以本抽屉里没有任何写操作 —— 唯一的动作是"复制型号名，去「新建模型」里粘贴"。
 * ② **不要求 Provider 启用、也不要求配 Key**：这正是"换 Key 后先探一次再启用"的诊断动作；
 *    没配 Key 就不带 `Authorization` 头去探，能不能成由上游决定 —— 于是"用不了"与"该实现
 *    不支持列表"能被区别开。所以探到了**不能**推断成"Key 配好了"（`remoteModelNotice` 会说）。
 * ③ **截断是显式的**：`items` 上限 500 条，超出时 `truncated: true` 而 `total` 仍是上游真实条数。
 *    界面上照实说"只列了前 N 个"，不静默截断（静默截断会让"某几个模型不见了"变成幽灵 bug）。
 */

import { Alert, Button, Drawer, Input, Table, Tooltip, type TableColumnsType } from 'antd'
import type { ModelProviderItem } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useCreateModel, useProbeRemoteModels } from '../../api/modelPool.js'
import { useFeedback } from '../../app/feedback.js'
import { ErrorState } from '../../components/ListStates.js'
import {
  buildCreateModelBody,
  describeProviderKey,
  maxContextText,
  remoteModelNotice,
  remoteModelRows,
  type ModelFormValues,
  type RemoteModelRow,
} from './adminModel.js'

export interface RemoteModelsDrawerProps {
  /** 要探的 Provider；`null` = 抽屉关闭 */
  provider: ModelProviderItem | null
  onClose: () => void
}

export function RemoteModelsDrawer({ provider, onClose }: RemoteModelsDrawerProps) {
  const feedback = useFeedback()
  const probe = useProbeRemoteModels()
  const create = useCreateModel()
  const [keyword, setKeyword] = useState('')
  // 多选：勾选的上游型号名，用于批量创建到本 Provider 下
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  const providerId = provider?.id ?? null

  // 打开即探一次（"点一下探一次"的诊断动作 —— 只有真的点了才会打上游）。
  // ⚠️ 依赖只放 `providerId`：把 `probe` 放进依赖会让每次 mutate 状态变化都再探一次，
  // 症状是"抽屉开着的时候上游被反复请求"（本仓的 ESLint 未启用 react-hooks 插件，
  // 这条约束靠注释与验收档的源码级断言守，见 `verify-admin-ui.mjs` 的 J 组）。
  useEffect(() => {
    if (providerId === null) {
      // 关闭即清掉上一次的结果：留着会让下次打开先闪一眼旧 Provider 的模型列表
      probe.reset()
      setKeyword('')
      setSelectedIds([])
      return
    }
    probe.mutate(providerId)
    setKeyword('')
    setSelectedIds([])
  }, [providerId])

  const result = probe.data
  const rows = result === undefined ? [] : remoteModelRows(result)
  const normalized = keyword.trim().toLowerCase()
  const filtered = normalized === '' ? rows : rows.filter((row) => row.id.toLowerCase().includes(normalized))

  const copy = (id: string): void => {
    void navigator.clipboard
      .writeText(id)
      .then(() => feedback.ok(`已复制型号名「${id}」`))
      .catch(() => feedback.fail(new Error('浏览器拒绝了剪贴板访问，请手工选中后复制'), '复制失败'))
  }

  /**
   * 批量创建：把勾选的上游型号名逐个建成本 Provider 下的模型。
   *
   * · 别名默认取型号名、类型取 Provider 类型、上下文长度取上游给的值（`null` 则不带）；
   *   支持图片/深度思考默认关（这些要管理员按模型确认，随后到「编辑」里改）。
   * · 逐个建、逐个兜错：已存在（409）等失败不阻断其余项，最后汇总成功/失败条数。
   */
  const createSelected = async (): Promise<void> => {
    if (provider === null || selectedIds.length === 0) return
    setCreating(true)
    const targets = rows.filter((row) => selectedIds.includes(row.id))
    let ok = 0
    const failures: string[] = []
    for (const row of targets) {
      const values: ModelFormValues = {
        providerId: provider.id,
        modelName: row.id,
        label: row.id,
        type: provider.type,
        maxContext: row.contextLength,
        supportsVision: false,
        supportsReasoning: false,
        enabled: true,
      }
      try {
        await create.mutateAsync(buildCreateModelBody(values))
        ok += 1
      } catch (error) {
        failures.push(`${row.id}（${describeError(error).message}）`)
      }
    }
    setCreating(false)
    setSelectedIds([])
    if (ok > 0) {
      feedback.ok(`已创建 ${ok} 个模型${failures.length > 0 ? `，${failures.length} 个失败` : ''}`)
    }
    if (failures.length > 0) {
      feedback.fail(new Error(failures.join('；')), ok > 0 ? '部分模型创建失败' : '模型创建失败')
    }
  }

  const columns: TableColumnsType<RemoteModelRow> = [
    {
      title: '上游型号名',
      dataIndex: 'id',
      render: (_, row) => (
        // 用 AntD 的文字链按钮而不是自写 `.linkish`：`styles/app.css` 里没有那个类
        // （`06` P0-1-30 定案：AntD 已有的样式不重写），照原型类名写会得到一个没有样式的裸按钮
        <Button type="link" size="small" style={{ padding: 0 }} title="点击复制" onClick={() => copy(row.id)}>
          {row.id}
        </Button>
      ),
    },
    {
      title: '归属',
      dataIndex: 'ownedBy',
      width: 160,
      render: (_, row) => <span className="num">{row.ownedBy ?? '—'}</span>,
    },
    {
      title: '上下文',
      dataIndex: 'contextLength',
      width: 120,
      align: 'right',
      render: (_, row) => <span className="num">{maxContextText(row.contextLength)}</span>,
    },
  ]

  return (
    <Drawer
      open={provider !== null}
      onClose={onClose}
      width={620}
      title={provider === null ? '拉取上游模型' : `上游模型 · ${provider.name}`}
    >
      {provider === null ? null : (
        <div className="stack">
          <div>
            <p className="num">{provider.baseUrl}</p>
            <p className="ratio">
              API Key：{describeProviderKey(provider)} · 类型：{provider.type}
            </p>
          </div>

          <Alert
            type="info"
            showIcon
            message="只读探测，勾选后可批量创建"
            description="这里探的是上游 /models 的真实返回。勾选想要的型号，点「创建选中的模型」即可批量建到本 Provider 下（别名默认取型号名、类型取 Provider 类型、上下文长度取上游值，可稍后编辑）。探到了也不代表调用一定成功（上游可能仍需鉴权或该型号不可用）。"
          />

          {probe.isPending && <p className="ratio">正在向上游发起一次请求…（可能较慢，内网地址会一直等到超时）</p>}

          {probe.isError && (
            <ErrorState
              title="探测失败"
              error={probe.error}
              retrying={probe.isPending}
              onRetry={() => probe.mutate(provider.id)}
            />
          )}

          {probe.isError === false && result !== undefined && (
            <>
              {remoteModelNotice(result, provider.hasKey) !== null && (
                <Alert
                  type={result.total === 0 ? 'warning' : 'info'}
                  showIcon
                  message={remoteModelNotice(result, provider.hasKey) ?? ''}
                />
              )}

              <div className="row row--wrap">
                <Input.Search
                  allowClear
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="过滤型号名…"
                  style={{ width: 240 }}
                  aria-label="过滤上游型号名"
                />
                <Button
                  type="primary"
                  disabled={selectedIds.length === 0 || creating}
                  loading={creating}
                  onClick={() => void createSelected()}
                >
                  创建选中的模型（{selectedIds.length}）
                </Button>
                <span className="ratio u-right">
                  上游共 <span className="num">{result.total}</span> 个
                  {result.truncated && <>（本次列出前 {result.items.length} 个）</>}
                </span>
              </div>

              {rows.length === 0 ? (
                <p className="ratio">上游返回的清单是空的。</p>
              ) : filtered.length === 0 ? (
                <p className="ratio">没有匹配「{keyword.trim()}」的型号名。</p>
              ) : (
                <Table<RemoteModelRow>
                  rowKey="id"
                  size="small"
                  columns={columns}
                  dataSource={filtered}
                  loading={false}
                  rowSelection={{
                    selectedRowKeys: selectedIds,
                    onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
                  }}
                  pagination={filtered.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
                />
              )}

              <p className="ratio">
                提示：勾选型号后可批量创建；也可点型号名复制到「新建模型」里手动录入。上游清单里常有
                embedding / 图像 / 老版本模型，不一定都能拿来做对话 —— 加进来之前先确认它的类型。
              </p>
            </>
          )}

          <Tooltip title="重新探一次（换过 Key 或改了 baseUrl 之后常用）">
            <Button onClick={() => probe.mutate(provider.id)} loading={probe.isPending}>
              重新探测
            </Button>
          </Tooltip>
        </div>
      )}
    </Drawer>
  )
}
