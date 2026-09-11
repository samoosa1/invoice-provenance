// Download half adapted from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/** Rows come from domain/exportRows.ts; this file only turns them into a file and hands it to the browser. */

import { EXPORT_HEADERS, exportRows, toCsv, type ExportableDocument } from '../domain/exportRows'
import { loadXlsx } from './xlsx'

const WIDTHS = [24, 26, 24, 10, 8, 5, 8, 8, 8, 8, 24]

export async function workbookBytes(docs: ExportableDocument[]): Promise<ArrayBuffer> {
  const xlsx = await loadXlsx()
  const sheet = xlsx.utils.aoa_to_sheet([[...EXPORT_HEADERS], ...exportRows(docs)])
  sheet['!cols'] = WIDTHS.map((wch) => ({ wch }))
  sheet['!freeze'] = { xSplit: '0', ySplit: '1' }
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, sheet, 'Fields')
  // `type: 'array'` returns an ArrayBuffer despite the name.
  return xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function downloadXlsx(docs: ExportableDocument[], fileName = 'invoice-fields.xlsx'): Promise<void> {
  download(new Blob([await workbookBytes(docs)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName)
}

export function downloadCsv(docs: ExportableDocument[], fileName = 'invoice-fields.csv'): void {
  download(new Blob([toCsv(exportRows(docs))], { type: 'text/csv;charset=utf-8' }), fileName)
}
