/**
 * ChatBot 并发闸的**只读出口**（P1-14 · R3 负载采样）
 *
 * 依据：`docs/子方案/沙箱多机部署.md` §九·补 2.1（`chatbotInFlight` ← `orchestrator/semaphore.ts`）。
 *
 * ⚠️ 为什么不直接从 `chatBot.ts` 导：那个模块在 import 期要拉 Prisma / 引擎 / 工具链，
 *    而实例心跳（`sandbox/owner.ts`）只需要**两个数字**。把信号量的持有处抬到这个小模块里，
 *    `owner.ts` 与 `chatBot.ts` 共享同一个实例（同一个闸门），且心跳路径不为采样付加载代价。
 */

import { config } from '../config.js'
import { createSemaphore } from './semaphore.js'

/** 进程级 ChatBot 并发闸（名额 = `CONCURRENCY_CHATBOT`） */
export const chatBotSlots = createSemaphore(config.concurrency.chatbot)
