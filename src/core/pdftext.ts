// 把 pdf.js 取出的一页文字块还原成文本：按坐标分行，同一行相距较远的文字块之间加空格。
// 浏览器（上传的 PDF、原文查看）和建库脚本共用，保证三处取到的文字一致。

export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

export function isTextItem(raw: unknown): raw is TextItemLike {
  return typeof raw === 'object' && raw !== null && 'str' in raw && 'transform' in raw;
}

export function pageItemsToText(items: unknown[]): string {
  const lines: string[] = [];
  let line = '';
  let lastY: number | null = null;
  let lastEnd = 0;
  for (const raw of items) {
    if (!isTextItem(raw)) continue;
    const it = raw;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 10;
    if (lastY !== null && Math.abs(y - lastY) > size * 0.5) {
      lines.push(line);
      line = '';
      lastEnd = 0;
    } else if (line && x - lastEnd > size * 0.9) {
      line += ' ';
    }
    line += it.str;
    lastY = y;
    lastEnd = x + it.width;
    if (it.hasEOL) {
      lines.push(line);
      line = '';
      lastY = null;
      lastEnd = 0;
    }
  }
  if (line) lines.push(line);
  return lines
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
