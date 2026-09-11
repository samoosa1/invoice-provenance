// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/**
 * On-demand loader for SheetJS. It is the largest dependency here and only
 * the export button needs it, so it never sits on the landing page's path.
 */

let cached: typeof import('xlsx') | undefined

export async function loadXlsx(): Promise<typeof import('xlsx')> {
  cached ??= await import('xlsx')
  return cached
}
