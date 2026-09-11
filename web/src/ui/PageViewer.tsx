/**
 * Renders one page of a PDF to a canvas at the width it is given, and draws
 * a highlight box over the selected field's provenance.
 *
 * The box is positioned with `transform: translate(...)`, never top/left,
 * so moving it between fields is a compositor-only animation (Musa's note
 * batch 3): no layout, no paint of the canvas underneath. Its size is set
 * directly (width/height), which changes only when the selection changes
 * and is not animated. `prefers-reduced-motion` turns the move into a jump.
 *
 * Coordinates: domain boxes are PDF points with a top-left origin (see
 * domain/types.ts), so css px = pt * (cssWidth / page.width) on both axes.
 */
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'

import type { Provenance } from '../domain/types'
import { loadPdfjs } from '../lib/pdf'

/** One open document per File; reopening on every selection would re-parse the PDF. */
const docCache = new WeakMap<File, Promise<PDFDocumentProxy>>()

function openDocument(file: File): Promise<PDFDocumentProxy> {
  let p = docCache.get(file)
  if (!p) {
    p = (async () => {
      const pdfjs = await loadPdfjs()
      return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    })()
    docCache.set(file, p)
  }
  return p
}

type Props = {
  file: File
  highlight: Provenance
  /** Which page to show when nothing is highlighted. */
  fallbackPage?: number
}

export function PageViewer({ file, highlight, fallbackPage = 1 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  const [cssWidth, setCssWidth] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const pageNo = highlight?.page ?? fallbackPage

  // Track the container's width; the canvas is re-rendered to fit it.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setCssWidth(Math.floor(entry.contentRect.width)))
    ro.observe(el)
    setCssWidth(Math.floor(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (cssWidth === 0) return
    let task: RenderTask | null = null
    let cancelled = false
    ;(async () => {
      try {
        const doc = await openDocument(file)
        const page = await doc.getPage(pageNo)
        const base = page.getViewport({ scale: 1 })
        if (cancelled) return
        setPageSize({ width: base.width, height: base.height })
        const scale = cssWidth / base.width
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: scale * dpr })
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${cssWidth}px`
        canvas.style.height = `${Math.round(cssWidth * (base.height / base.width))}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        task = page.render({ canvas, canvasContext: ctx, viewport })
        await task.promise
        setError(null)
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === 'RenderingCancelledException')) return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [file, pageNo, cssWidth])

  const k = pageSize && cssWidth ? cssWidth / pageSize.width : 0
  const box = highlight && k ? highlight.bbox : null
  // 3px of breathing room around the glyphs so the box frames the value instead of clipping its ascenders.
  const pad = 3

  return (
    <div className="viewer" ref={wrapRef}>
      <canvas ref={canvasRef} className="page" aria-label={`Page ${pageNo} of ${file.name}`} />
      {box && (
        <div
          className="highlight"
          aria-hidden="true"
          style={{
            width: `${box.width * k + pad * 2}px`,
            height: `${box.height * k + pad * 2}px`,
            transform: `translate(${box.x * k - pad}px, ${box.y * k - pad}px)`,
          }}
        />
      )}
      {error && (
        <p className="notice bad" role="alert">
          Could not render page {pageNo}: {error}
        </p>
      )}
    </div>
  )
}
