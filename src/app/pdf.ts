// 浏览器里的 PDF 处理：提取文字（按页），以及渲染原始页面供查看引用。

import { GlobalWorkerOptions, OPS, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { pageSegments, pageToMarkdown, type OpsCodes } from '../core/pdflayout.ts';
import { pageItemsToText } from '../core/pdftext.ts';

GlobalWorkerOptions.workerSrc = workerUrl;

export function openPdf(src: { data?: ArrayBuffer; url?: string }): Promise<PDFDocumentProxy> {
  return getDocument({
    ...(src.data ? { data: new Uint8Array(src.data.slice(0)) } : { url: src.url }),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  }).promise;
}

/**
 * 提取文字。pages：逐页原文（核对引用、高亮原件用）；markdown：按版面还原的 Markdown（表格还原成表格，给 agent 阅读）。
 * 版面还原失败时 markdown 为空，退回只用原文。
 */
export async function pdfToText(data: ArrayBuffer): Promise<{ text: string; pages: string[]; markdown?: string; tables?: number }> {
  const doc = await openPdf({ data });
  const pages: string[] = [];
  const md: string[] = [];
  let tables = 0;
  let layoutOk = true;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(pageItemsToText(content.items));
    if (!layoutOk) continue;
    try {
      const ops = await page.getOperatorList();
      const r = pageToMarkdown(content.items, pageSegments(ops.fnArray, ops.argsArray, OPS as unknown as OpsCodes));
      md.push(`<!-- 第 ${p} 页 -->\n${r.markdown}`);
      tables += r.tables;
    } catch {
      layoutOk = false;
    }
  }
  await doc.destroy();
  return { text: pages.join('\n\n'), pages, ...(layoutOk && tables > 0 ? { markdown: md.join('\n\n'), tables } : {}) };
}
