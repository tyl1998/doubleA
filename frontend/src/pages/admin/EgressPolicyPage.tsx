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
import {
  EGRESS_SCOPES,
  EGRESS_SCOPE_KEY,
  type EgressPolicyMode,
  type EgressScope,
  type MessageKey,
} from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { useEgressPolicy, useUpdateEgressPolicy } from '../../api/egressPolicy.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { localeTag } from '../../app/locale.js'

/** 推导模式 → 文案 key（三档语义与「口径」列表里的三条同名，不另造词） */
const MODE_LABEL_KEY: Record<EgressPolicyMode, MessageKey> = {
  ALLOW_ALL: 'egress.noteScopeAll',
  WHITELIST: 'egress.noteAllowStrong',
  BLACKLIST: 'egress.noteDenyStrong',
}

const MODE_TAG_COLOR: Record<EgressPolicyMode, string> = {
  ALLOW_ALL: 'green',
  WHITELIST: 'blue',
  BLACKLIST: 'orange',
}

export function EgressPolicyPage() {
  const feedback = useFeedback()
  const { t, locale } = useT()
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
        feedback.ok(t('egress.saved'))
      },
      onError: (error) => feedback.fail(error, t('egress.saveFailed')),
    })
  }

  const mode = query.data?.mode

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('egress.title')}</h1>
          <p className="page__lead">
            {t('egress.leadPrefix')}
            <strong>{t('egress.leadStrong1')}</strong>
            {t('egress.leadMid')}
            <strong>{t('egress.leadStrong2')}</strong>
            {t('egress.leadTail')}
            <strong>{t('egress.leadStrong3')}</strong>
            {t('egress.leadEnd')}
          </p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('egress.noteTitle')}
        description={
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>
              <strong>{t('egress.noteScopeStrong')}</strong>
              {t('egress.noteScopeMid')}
              <strong>{t('egress.noteScopeAll')}</strong>
              {t('egress.noteScopeAllTail')}
              <strong>{t('egress.noteScopeNone')}</strong>
              {t('egress.noteScopeNoneTail')}
              <strong>{t('egress.noteScopeRegistry')}</strong>
              {t('egress.noteScopeRegistryTail')}
              <strong>{t('egress.noteScopeAlways')}</strong>
              {t('egress.noteScopeEnd')}
            </li>
            <li>
              <strong>{t('egress.noteAllowStrong')}</strong>
              {t('egress.noteAllowMid')}
              <strong>{t('egress.noteAllowStrong2')}</strong>
              {t('egress.noteAllowTail')}
            </li>
            <li>
              <strong>{t('egress.noteDenyStrong')}</strong>
              {t('egress.noteDenyMid')}
              <strong>{t('egress.noteDenyStrong2')}</strong>
              {t('egress.noteDenyTail')}
            </li>
            <li>
              {t('egress.noteShapePrefix')}
              <code>host</code>
              {t('egress.noteShapeMid1')}
              <code>host:port</code>
              {t('egress.noteShapeMid2')}
              <code>*.host</code>
              {t('egress.noteShapeMid3')}
              <code>github.com</code>
              {t('egress.noteShapeMid4')}
              <code>*.example.com</code>
              {t('egress.noteShapeTail')}
            </li>
            <li>
              {t('egress.noteSyncPrefix')}
              <code>egress-up.sh --watch</code>
              {t('egress.noteSyncMid')}
              <strong>{t('egress.noteSyncStrong')}</strong>
              {t('egress.noteSyncTail')}
            </li>
          </ul>
        }
      />

      {query.isLoading || form === null ? (
        <Spin />
      ) : (
        <Space direction="vertical" size="large" style={{ display: 'flex' }}>
          <div>
            <Typography.Text strong>{t('egress.currentMode')}</Typography.Text>{' '}
            {mode === undefined ? (
              <Tag>—</Tag>
            ) : (
              <Tag color={MODE_TAG_COLOR[mode]}>{t(MODE_LABEL_KEY[mode])}</Tag>
            )}
            {query.data !== undefined && (
              <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                {t('egress.scopePrefix')}
                {t(EGRESS_SCOPE_KEY[query.data.scope])}
                {t('egress.scopeMid')}
                {new Date(query.data.updatedAt).toLocaleString(localeTag(locale))}
              </Typography.Text>
            )}
          </div>

          <div>
            <Typography.Text strong>{t('egress.scopeLabel')}</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={form.scope}
              onChange={(value: EgressScope) => setForm({ ...form, scope: value })}
              options={EGRESS_SCOPES.map((scope) => ({ value: scope, label: t(EGRESS_SCOPE_KEY[scope]) }))}
            />
          </div>

          <div>
            <Typography.Text strong>{t('egress.allowLabel')}</Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%', marginTop: 8 }}
              placeholder={t('egress.allowPlaceholder')}
              value={form.allowHosts}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(value: string[]) => setForm({ ...form, allowHosts: value })}
              open={false}
              suffixIcon={null}
            />
          </div>

          <div>
            <Typography.Text strong>{t('egress.denyLabel')}</Typography.Text>
            <Select
              mode="tags"
              style={{ width: '100%', marginTop: 8 }}
              placeholder={t('egress.denyPlaceholder')}
              value={form.denyHosts}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(value: string[]) => setForm({ ...form, denyHosts: value })}
              open={false}
              suffixIcon={null}
            />
          </div>

          <div>
            <Button type="primary" loading={save.isPending} onClick={submit}>
              {t('egress.save')}
            </Button>
          </div>
        </Space>
      )}
    </>
  )
}
