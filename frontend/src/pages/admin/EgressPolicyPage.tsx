/**
 * 沙箱出网策略（`/admin/egress`，**ADMIN**）—— 出网范围 + 黑白名单
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.5（出网平台化 + 实时注入）+ §五 7.5b（出网范围，P1-16a）；
 * 契约 `shared/src/egressPolicy.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一页在配什么
 * ─────────────────────────────────────────────────────────────────────
 * 沙箱容器挂在专用 internal bridge 上、**没有公网路由** ⇒ 出公网只可能经 egress 代理。
 * 本页配置代理的**平台级策略**（单例、所有会话共用）：
 *   · **出网范围（`scope`，P1-16a）**：`ALL` 全放行（默认）/ `NONE` 仅模型 / `REGISTRY` 模型 + 取包；
 *     它决定**基线放行集**；
 *   · 白名单（`allowHosts`）：在**范围之上**再加零散主机（如某个内网 git）；
 *   · 黑名单（`denyHosts`）：**永远硬拒**，优先级最高。
 * `mode` 是服务端对**范围解析后**两张表的**推导**（不单独存储），页面只读展示。
 *
 * ⚠️ **出网范围是平台级、不是会话级**（2026-10-14 用户定案）：**不在会话设置里配**，统一配在这里。
 * ⚠️ 保存的是"平台声明"，**真实拦截在 egress 代理容器**：由 `egress-up.sh --watch` 轮询本表、
 *    落成代理挂载的策略文件，代理每 5s 热更新 ⇒ 生效延迟 = 同步间隔 + ≤5s。
 * ⚠️ 规则形状：`host` / `host:port` / `*.host`（如 `github.com`、`registry.npmjs.org:443`、`*.example.com`）。
 */

import { Alert, Button, Select, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { EGRESS_SCOPES, EGRESS_SCOPE_LABELS, type EgressPolicyMode, type EgressScope } from '@doubulea/shared'

import { useEgressPolicy, useUpdateEgressPolicy } from '../../api/egressPolicy.js'
import { useFeedback } from '../../app/feedback.js'

const MODE_LABELS: Record<EgressPolicyMode, string> = {
  ALLOW_ALL: '全放行',
  WHITELIST: '仅白名单',
  BLACKLIST: '黑名单',
}

const MODE_TAG_COLOR: Record<EgressPolicyMode, string> = {
  ALLOW_ALL: 'green',
  WHITELIST: 'blue',
  BLACKLIST: 'orange',
}

export function EgressPolicyPage() {
  const feedback = useFeedback()
  const query = useEgressPolicy()
  const save = useUpdateEgressPolicy()

  /** 表单态；`null` = 还没从服务端铺过（首帧） */
  const [form, setForm] = useState<{ scope: EgressScope; allowHosts: string[]; denyHosts: string[] } | null>(null)

  useEffect(() => {
    if (query.data !== undefined && form === null) {
      setForm({ scope: query.data.scope, allowHosts: query.data.allowHosts, denyHosts: query.data.denyHosts })
    }
  }, [query.data, form])

  const submit = (): void => {
    if (form === null) return
    save.mutate(form, {
      onSuccess: (data) => {
        setForm({ scope: data.scope, allowHosts: data.allowHosts, denyHosts: data.denyHosts })
        feedback.ok('出网策略已保存（代理将在同步间隔内热更新）')
      },
      onError: (error) => feedback.fail(error, '保存出网策略失败'),
    })
  }

  const mode = query.data?.mode

  return (
    <>
      <div className="page__head">
        <div>
          <h1>出网策略</h1>
          <p className="page__lead">
            沙箱在专用内网上<strong>没有公网路由</strong>，出网只可能经 egress 代理。这里配置代理的
            <strong>出网范围 + 黑白名单</strong>（平台级，所有会话共用）。<strong>默认全放行</strong>。
          </p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message="口径"
        description={
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>
              <strong>出网范围</strong>：<strong>全放行</strong>（默认，除黑名单外都放行）/
              <strong>仅模型</strong>（只放行模型池，容器仍能调模型）/ <strong>模型 + 取包</strong>
              （模型池 + 注册表 + git 主机，可 clone / 装依赖）。模型池主机<strong>恒放行</strong>。
            </li>
            <li>
              <strong>白名单</strong>：在范围之上<strong>再加</strong>零散主机（如某个内网 git 源）；范围是全放行时它无意义。
            </li>
            <li><strong>黑名单</strong>：命中即拒，<strong>优先级最高</strong>（任何范围都拦得住）。</li>
            <li>条目形状：<code>host</code>、<code>host:port</code>、<code>*.host</code>（如 <code>github.com</code>、<code>*.example.com</code>）。</li>
            <li>保存后由 <code>egress-up.sh --watch</code> 同步到代理，生效有几十秒延迟；<strong>SSH(22) 不走该代理</strong>（git 请用 HTTPS）。</li>
          </ul>
        }
      />

      {query.isLoading || form === null ? (
        <Spin />
      ) : (
        <Space direction="vertical" size="large" style={{ display: 'flex' }}>
          <div>
            <Typography.Text strong>当前模式</Typography.Text>{' '}
            {mode === undefined ? (
              <Tag>—</Tag>
            ) : (
              <Tag color={MODE_TAG_COLOR[mode]}>{MODE_LABELS[mode]}</Tag>
            )}
            {query.data !== undefined && (
              <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                范围 {EGRESS_SCOPE_LABELS[query.data.scope]}｜上次更新{' '}
                {new Date(query.data.updatedAt).toLocaleString()}
              </Typography.Text>
            )}
          </div>

          <div>
            <Typography.Text strong>出网范围</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={form.scope}
              onChange={(value: EgressScope) => setForm({ ...form, scope: value })}
              options={EGRESS_SCOPES.map((scope) => ({ value: scope, label: EGRESS_SCOPE_LABELS[scope] }))}
            />
          </div>

          <div>
            <Typography.Text strong>白名单（allowHosts）</Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%', marginTop: 8 }}
              placeholder="在范围之上再加主机；留空 = 不加；如 github.com、*.githubusercontent.com"
              value={form.allowHosts}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(value: string[]) => setForm({ ...form, allowHosts: value })}
              open={false}
              suffixIcon={null}
            />
          </div>

          <div>
            <Typography.Text strong>黑名单（denyHosts）</Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%', marginTop: 8 }}
              placeholder="留空 = 不启用黑名单；命中即拒，优先级最高"
              value={form.denyHosts}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(value: string[]) => setForm({ ...form, denyHosts: value })}
              open={false}
              suffixIcon={null}
            />
          </div>

          <div>
            <Button type="primary" loading={save.isPending} onClick={submit}>
              保存
            </Button>
          </div>
        </Space>
      )}
    </>
  )
}
