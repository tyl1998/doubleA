/**
 * `mammoth` 的类型声明（P0-1-16）
 *
 * 为什么要有这个文件：`mammoth@1.12.3` **不带类型、npm 上也没有 `@types/mammoth`**
 * （实测 404），而本仓库是 `strict` + `noImplicitAny` —— 不声明就 `tsc` 不过。
 *
 * 为什么不用 `require` + `// @ts-expect-error`：那样会把"mammoth 到底返回什么"这件事
 * 从类型系统里彻底抹掉，而本层**恰好依赖**它返回的 `value`（HTML 串）与 `messages`
 * （解析告警）两个字段 —— 让它们有名字是值得的。
 *
 * 刻意只声明本项目真正用到的部分（`convertToHtml` / `extractRawText`）。**不追求完整**：
 * 一份"抄来的全量声明"会随上游漂移，而这里只声明用到的，多声明一个字段就是多一份失配风险。
 * 需要新能力时在此追加，并在 `parse/docx.ts` 里用起来。
 */
declare module 'mammoth' {
  /** mammoth 的告警/信息条目（不是错误：出现它说明"有些东西没能还原"） */
  export interface MammothMessage {
    type: string
    message: string
  }

  export interface MammothResult {
    value: string
    messages: MammothMessage[]
  }

  export interface MammothInput {
    /** 输入方式用 buffer：本项目的文件来自 multipart 与 S3，都在内存里 */
    buffer: Buffer
  }

  export interface MammothOptions {
    /** 样式映射（本项目**不传**：传它会替换掉 mammoth 的默认映射，标题反而会丢） */
    styleMap?: string[]
    includeDefaultStyleMap?: boolean
  }

  /** Word 语义结构 → HTML（本项目据此取标题层级与段落） */
  export function convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>

  /** Word → 纯文本（丢结构；本项目不用它，只在排查时对照） */
  export function extractRawText(input: MammothInput): Promise<MammothResult>

  const mammoth: {
    convertToHtml: typeof convertToHtml
    extractRawText: typeof extractRawText
  }
  export default mammoth
}
