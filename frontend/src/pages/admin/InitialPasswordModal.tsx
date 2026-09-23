/**
 * 一次性初始密码弹窗（P0-1-36）
 *
 * 依据：`docs/02-后端设计.md` §4.2「初始密码的生命周期：只在建号/重置密码**那一次响应**的
 *      `data.initialPassword` 里出现，之后任何列表/详情接口都不再带」+ `01` §3.1 验收要点
 *      「admin 建号发初始密码」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个弹窗存在的唯一理由：明文只有一次
 * ─────────────────────────────────────────────────────────────────────
 * 响应里的 `initialPassword` 是**唯一一次**能看到明文的地方（列表接口连 `hasPassword` 都没有）。
 * 所以建号/重置成功后**必须立刻**把它摆到用户眼前，而不是先弹一句"创建成功"再指望用户
 * 自己去别处找 —— 那一瞬间过去，唯一能做的补救就是再重置一次（对方拿到的第一个密码作废）。
 *
 * 三条落地口径：
 *   · **不能自动关闭**：`maskClosable={false}` + 不给右上角 ×（`closable={false}`）——
 *     误点空白处就把唯一一份明文弄丢，代价与"少点一次"完全不成比例；
 *   · **给复制按钮**：手工选中一串 18 位随机字符再抄到邮件里，是这个流程里最容易出错的一步；
 *   · **写明"关闭后无法再查看"**，让"要不要现在复制"变成一个有依据的决定，而不是事后才知道。
 *
 * ⚠️ **本弹窗是全站唯一一个不响应 Esc 的弹窗**（`keyboard={false}`），这是对 `03` §七
 * 「Esc 关闭弹窗与抽屉」的一处**显式例外**：那条约定是给"随时可以再打开一次"的弹窗定的
 * （编辑/配置/检索测试都属此类，关掉重开内容还在）。这一个关掉之后**没有重开的路径** ——
 * 唯一补救是再重置一次，而对方手上那份作废。所以这里把 Esc 也纳入"必须点按钮"的范围，
 * 并把出口写成两个明确按钮（「复制」「我已保存，关闭」）。
 * 例外只此一处，且写在代码里而不是靠记忆（`docs/03` §七 的回写里有对应条目）。
 */

import { Alert, Button, Input, Modal } from 'antd'
import type { InitialPasswordResult } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { useFeedback } from '../../app/feedback.js'
import { initialPasswordCopyText, initialPasswordNotice } from './adminModel.js'

export interface InitialPasswordModalProps {
  /** `null` = 关闭。两种来路：刚建号 / 刚重置密码（`forReset` 只影响文案动词） */
  result: InitialPasswordResult | null
  forReset: boolean
  onClose: () => void
}

export function InitialPasswordModal({ result, forReset, onClose }: InitialPasswordModalProps) {
  const feedback = useFeedback()
  const [copied, setCopied] = useState(false)

  // 每次打开都复位"已复制"标记：不复位会让下一次打开时按钮写着"已复制"而其实没复制
  useEffect(() => {
    setCopied(false)
  }, [result])

  if (result === null) return null

  const copy = (): void => {
    void navigator.clipboard
      .writeText(initialPasswordCopyText(result.user.username, result.initialPassword))
      .then(() => {
        setCopied(true)
        feedback.ok('已复制用户名与初始密码')
      })
      .catch(() => {
        // 剪贴板在非 https / 无权限时会失败 —— 这时**不能**说"已复制"
        feedback.fail(new Error('浏览器拒绝了剪贴板访问，请手工选中后复制'), '复制失败')
      })
  }

  return (
    <Modal
      open
      title={forReset ? '密码已重置' : '账号已创建'}
      // ⚠️ 不给 ×、不响应点遮罩：这个弹窗里装着**唯一一份明文**，误关的代价无法补救
      closable={false}
      maskClosable={false}
      keyboard={false}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={copy}>{copied ? '再复制一次' : '复制用户名与密码'}</Button>
          <Button type="primary" onClick={onClose}>
            我已保存，关闭
          </Button>
        </>
      }
    >
      <div className="stack stack--tight">
        <Alert type="warning" showIcon message="初始密码只显示这一次" description={initialPasswordNotice(result.user.username, forReset)} />

        <div>
          <p className="block-label">用户名</p>
          <Input readOnly value={result.user.username} className="num" aria-label="用户名" />
        </div>

        <div>
          <p className="block-label">初始密码</p>
          <Input readOnly value={result.initialPassword} className="num" aria-label="初始密码" />
        </div>

        <p className="ratio">
          关闭这个弹窗之后，这份明文就再也取不回来了（后端只在这一次响应里下发）。如果没记住，
          只能重新建号或再重置一次 —— 那会让对方手上的旧密码作废。
        </p>
      </div>
    </Modal>
  )
}
