/**
 * CSV / TSV 预览（`子方案④` §五 5）—— **虚拟滚动表格**
 *
 * 四条口径，每一条都对应一个"不这么做就会出错"的后果：
 *
 * ① **解析器是自写的 RFC 4180 纯函数**（`artifactPreview.ts#parseCsvText`），**不引第三方库**
 *    —— 那样它才能进**无依赖验收档**逐条断言（引号内换行、`""` 转义、CRLF…），
 *    而"引个库"就意味着这些分支只能靠肉眼在界面上试；
 * ② **分隔符按 mime 定，不做嗅探**（`csvDelimiterOf`）：嗅探猜错是**静默**的，
 *    而且同一份文件在不同浏览器上可能猜出不同结果；
 * ③ **首行当表头**，不给开关（P0 简化；验收场景"汇总表"必然有表头）⇒ 这个取舍要**写在明处**
 *    （工具栏那行读数里已经说了"首行按表头渲染"）；
 * ④ **三处截断必须在界面上明示**（行 / 列 / 单元格），且读数报的是**截断前**的数 ——
 *    报截断后的数等于对用户说"这份文件就 5000 行"，那是一句假话。
 *
 * ⚠️ **不做公式注入（`=cmd|...`）清洗**（`子方案④` §八 4）：我们**不改动产物字节**，
 * 只在浏览器里显示文本；把 `=SUM(A1)` 改成 `'=SUM(A1)` 会让"预览"与"下载"看到两份不同的数据。
 *
 * 表格用 **AntD `Table` 的 `virtual`**（5.x 自带 ⇒ **零新增依赖**）。
 */

import { Table, type TableColumnsType } from 'antd'

import { useT } from '../../app/i18n.js'
import { buildCsvTable, csvTableNote, type CsvTable } from './artifactPreview.js'

/** 一行（AntD 的 `dataSource` 要对象 + `rowKey` ⇒ 包一层，单元格数组原样带着） */
interface CsvRow {
  /** 数据行序号（0 基；显示时 +1，与"第几行"对齐） */
  index: number
  cells: string[]
}

export interface CsvPreviewProps {
  text: string
  /** `csvDelimiterOf(mime)` 的返回值（调用方已判过不是 `null`） */
  delimiter: string
}

export function CsvPreview({ text, delimiter }: CsvPreviewProps) {
  const { locale, t } = useT()
  const table: CsvTable = buildCsvTable(text, delimiter)
  const note = csvTableNote(table, locale)

  const columns: TableColumnsType<CsvRow> = [
    {
      title: '#',
      key: 'row',
      width: 64,
      align: 'right',
      render: (_, row) => <span className="num">{row.index + 1}</span>,
    },
    ...table.header.map((name, index) => ({
      // 空表头（`,,` 这种）也要有一列 ⇒ 给一个"第 N 列"的占位名，否则整列看起来是空的
      title: name === '' ? t('artifact.preview.csvColPlaceholder', { index: index + 1 }) : name,
      key: `c${index}`,
      width: 160,
      ellipsis: true,
      render: (_: unknown, row: CsvRow) => row.cells[index] ?? '',
    })),
  ]

  const dataSource: CsvRow[] = table.rows.map((cells, index) => ({ index, cells }))

  return (
    <div className="preview preview--csv">
      <p className="ratio">
        {t('artifact.preview.csvHeaderNote', { rows: table.totalRows, cols: table.totalCols })}
      </p>
      {note !== null && <p className="ratio">{note}</p>}
      <Table<CsvRow>
        rowKey="index"
        size="small"
        virtual
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        scroll={{ y: 460, x: 'max-content' }}
        locale={{ emptyText: t('artifact.preview.csvEmpty') }}
      />
    </div>
  )
}
