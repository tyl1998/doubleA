/**
 * 本进程的**节点档位**读取（薄壳）。
 *
 * 判据只有一处（`sandbox/roleOverride.ts#detectNodeRole`），这里只是给路由层一个稳定入口，
 * 避免路由去 import 沙箱内部模块。
 */

import { detectNodeRole, NODE_ROLES, type NodeRole } from '../sandbox/roleOverride.js'

export type { NodeRole }

/** 读显式声明的档位（未声明/非法 ⇒ `undefined`） */
export function detectNodeRoleSafe(env: NodeJS.ProcessEnv = process.env): NodeRole | undefined {
  return detectNodeRole(env)
}

/** 类型守卫（路由把手写的字符串收窄成档位） */
export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === 'string' && (NODE_ROLES as readonly string[]).includes(value)
}
