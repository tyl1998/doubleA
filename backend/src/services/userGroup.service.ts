/**
 * 用户组服务（P1-18 · 子批 B；`子方案/资产共享与用户组标签.md` §四）
 *
 * 组 = **显式成员集合**，由 **ADMIN 维护**（路由层 `requireAdmin`），是 Agent「指定用户」受众的
 * 主授权单位。本文件不碰 Fastify：路由只做"校验 → 调服务 → 组装信封"。
 *
 * 一条贯穿本文件的注意点：**`agent_audiences.subject_id` 是"多态外键、无 FK"** —— 删组时
 * 数据库**不会**替你清掉指向它的受众行（否则那条受众行会变成"永远命不中任何人、界面上却还在"）。
 * 因此 {@link removeUserGroup} 必须在**一个事务**里把该组的受众行一并删掉（同 Agent 软删要显式解绑
 * 组件的口径，见 `agent.service.ts` 文件头 ②）。
 */

import {
  AppError,
  type CreateUserGroupBody,
  type ListUserGroupsQuery,
  type OffsetPage,
  type ReplaceUserGroupMembersBody,
  type UpdateUserGroupBody,
  type UserGroupDetail,
  type UserGroupItem,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'

/** 用户组本身的查询字段 */
const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true } },
} as const

interface GroupRow {
  id: string
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
  _count: { members: number }
}

function toItem(row: GroupRow): UserGroupItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: row._count.members,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Prisma 已知错误码（鸭子类型：跨构建产物的 `instanceof` 不可靠，同 `user.service.ts`） */
function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/** 列表（`GET /api/admin/groups`）：按创建时间倒序 + id 兜底保证分页稳定 */
export async function listUserGroups(query: ListUserGroupsQuery): Promise<OffsetPage<UserGroupItem>> {
  const db = getPrisma()
  const [rows, total] = await db.$transaction([
    db.userGroup.findMany({
      select: GROUP_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.userGroup.count(),
  ])
  return { items: rows.map(toItem), total, offset: query.offset, limit: query.limit }
}

/** 详情（`GET /api/admin/groups/:id`，含成员清单）。 */
export async function getUserGroup(id: string): Promise<UserGroupDetail> {
  const db = getPrisma()
  const row = await db.userGroup.findUnique({
    where: { id },
    select: {
      ...GROUP_SELECT,
      members: {
        orderBy: { createdAt: 'asc' },
        select: { user: { select: { id: true, username: true, nickname: true } } },
      },
    },
  })
  if (row === null) throw AppError.notFound('用户组不存在')
  return {
    ...toItem(row),
    members: row.members.map((m) => ({
      id: m.user.id,
      name: m.user.nickname ?? m.user.username,
    })),
  }
}

/** 建组（`POST /api/admin/groups`）。名称唯一（DB `@@unique`）—— 冲突给可读 409。 */
export async function createUserGroup(input: CreateUserGroupBody): Promise<UserGroupItem> {
  const db = getPrisma()
  try {
    const created = await db.userGroup.create({
      data: { name: input.name, description: input.description ?? null },
      select: GROUP_SELECT,
    })
    getLogger().info({ groupId: created.id, name: created.name }, '已创建用户组')
    return toItem(created)
  } catch (error) {
    if (hasPrismaCode(error, 'P2002')) throw AppError.conflict(`已存在同名用户组：${input.name}`)
    throw error
  }
}

/** 改组（`PATCH /api/admin/groups/:id`）：改名 / 改描述（三态）。 */
export async function updateUserGroup(id: string, input: UpdateUserGroupBody): Promise<UserGroupItem> {
  const db = getPrisma()
  try {
    const updated = await db.userGroup.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        // `null` = 清空 / `undefined` = 不动（用 `!== undefined` 判，不能真值判断）
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      select: GROUP_SELECT,
    })
    getLogger().info({ groupId: id, changed: Object.keys(input) }, '已更新用户组')
    return toItem(updated)
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('用户组不存在')
    if (hasPrismaCode(error, 'P2002')) throw AppError.conflict('已存在同名用户组')
    throw error
  }
}

/**
 * 整体替换成员（`PUT /api/admin/groups/:id/members`）：**提交什么，库里就有什么**。
 *
 * 先校验每个 userId 存在（`user_group_members.user_id` 有 FK，不存在会在插入时抛 `P2003` ⇒ 500；
 * 这里前置成可读 400），再在**一个事务**里 `deleteMany` + `createMany`。
 */
export async function replaceUserGroupMembers(
  id: string,
  input: ReplaceUserGroupMembersBody,
): Promise<UserGroupDetail> {
  const db = getPrisma()
  const group = await db.userGroup.findUnique({ where: { id }, select: { id: true } })
  if (group === null) throw AppError.notFound('用户组不存在')

  const userIds = [...new Set(input.userIds)]
  if (userIds.length > 0) {
    const found = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })
    const missing = userIds.filter((uid) => !found.some((u) => u.id === uid))
    if (missing.length > 0) throw AppError.validation(`成员里有不存在的用户：${missing.join('、')}`)
  }

  await db.$transaction(async (tx) => {
    await tx.userGroupMember.deleteMany({ where: { groupId: id } })
    if (userIds.length > 0) {
      await tx.userGroupMember.createMany({
        data: userIds.map((userId) => ({ groupId: id, userId })),
        skipDuplicates: true,
      })
    }
  })
  getLogger().info({ groupId: id, memberCount: userIds.length }, '已整体替换用户组成员')
  return getUserGroup(id)
}

/**
 * 删组（`DELETE /api/admin/groups/:id`）。**一个事务里两件事**：删组（成员级联删）+ 删指向它的受众行。
 *
 * ⚠️ 第二件不能省：`agent_audiences.subject_id` 无 FK ⇒ 不删就留下"指向一个已不存在的组"的受众行，
 * 而那会让一个 `SHARED` Agent 的受众集合里永远挂着一个空主体（界面上显示"已选 1 个组"，实际没人命中）。
 */
export async function removeUserGroup(
  id: string,
): Promise<{ id: string; name: string; removedAudiences: number }> {
  const db = getPrisma()
  const group = await db.userGroup.findUnique({ where: { id }, select: { id: true, name: true } })
  if (group === null) throw AppError.notFound('用户组不存在')

  const removedAudiences = await db.$transaction(async (tx) => {
    const removed = await tx.agentAudience.deleteMany({
      where: { subjectType: 'GROUP', subjectId: id },
    })
    await tx.userGroup.delete({ where: { id } })
    return removed.count
  })

  getLogger().info({ groupId: id, name: group.name, removedAudiences }, '已删除用户组（并清掉指向它的受众行）')
  return { id: group.id, name: group.name, removedAudiences }
}

/**
 * 解析某用户所属的**组 id 集合**（受众命中判据用；供 Agent 服务复用）。
 * 与 `agent.service.ts#resolveViewerGroupIds` 同口径 —— 保留在这里是为了"组相关查询只有一个出口"。
 */
export async function groupIdsOfUser(userId: string): Promise<string[]> {
  const rows = await getPrisma().userGroupMember.findMany({
    where: { userId },
    select: { groupId: true },
  })
  return rows.map((row) => row.groupId)
}
