// 上传的 PDF 公告：按版面还原成 Markdown，重点是表格。
//
// pdf.js 提取的文字是一行一行的，表格会被压平：多列的值挤在一行（"161125 012860"），
// 跨行的单元格和旁边的列交错在一起，哪个值属于哪一列要靠模型猜。
// 这里用 PDF 里画出来的表格线（矢量线段和细矩形）还原单元格：
//   1. 从绘图指令里取出所有水平线、竖直线（按变换矩阵换算到页面坐标）；
//   2. 相交的线段连成一张表，横线和竖线的位置构成网格；
//   3. 网格中缺了分隔线的相邻格子合并成一个单元格（合并单元格）；
//   4. 把每个文字块放进它所在的单元格，输出 Markdown 表格。
// 表格以外的文字仍按原来的办法逐行输出。只输出原文里的字，不增删任何文字；
// 核对引用仍然用 pageItemsToText 提取的原文（见 pdftext.ts）。

import { isTextItem, type TextItemLike } from './pdftext.ts';

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** pdf.js 的绘图指令编号（OPS）里用到的几个 */
export interface OpsCodes {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  rectangle?: number;
}

type Matrix = [number, number, number, number, number, number];

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 从一页的绘图指令里取出画出来的线段（描边或填充的路径；只用作裁剪的路径不算）。坐标是 PDF 页面坐标（y 向上）。 */
export function pageSegments(fnArray: number[], argsArray: unknown[], ops: OpsCodes): Segment[] {
  const paint = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const out: Segment[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform && args) ctm = mul(args.map(Number) as Matrix, ctm);
    else if (fn === ops.constructPath && args) {
      const drawOp = Number(args[0]);
      if (!paint.has(drawOp)) continue;
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0];
      if (!data) continue;
      pathSegments(Array.from(data), ctm, out);
    }
  }
  return out;
}

/** 路径数据：0 moveTo x y · 1 lineTo x y · 2 curveTo 6 个数 · 3 quadraticCurveTo 4 个数 · 4 closePath */
function pathSegments(d: number[], m: Matrix, out: Segment[]): void {
  let start: [number, number] | null = null;
  let cur: [number, number] | null = null;
  const line = (a: [number, number], b: [number, number]) => {
    const [x1, y1] = apply(m, a[0], a[1]);
    const [x2, y2] = apply(m, b[0], b[1]);
    out.push({ x1, y1, x2, y2 });
  };
  let i = 0;
  while (i < d.length) {
    const op = d[i];
    if (op === 0) {
      cur = start = [d[i + 1], d[i + 2]];
      i += 3;
    } else if (op === 1) {
      const p: [number, number] = [d[i + 1], d[i + 2]];
      if (cur) line(cur, p);
      cur = p;
      i += 3;
    } else if (op === 2) {
      cur = [d[i + 5], d[i + 6]];
      i += 7;
    } else if (op === 3) {
      cur = [d[i + 3], d[i + 4]];
      i += 5;
    } else if (op === 4) {
      if (cur && start) line(cur, start);
      cur = start;
      i += 1;
    } else break;
  }
}

// ---------------------------------------------------------------- 线段 → 表格网格

interface HLine {
  y: number;
  x1: number;
  x2: number;
}
interface VLine {
  x: number;
  y1: number;
  y2: number;
}

const TOL = 2.5;

/** 线段归为横线、竖线。细长的填充矩形（很多 Word 生成的 PDF 用它画表格线）的四条边也会落到这里，再按位置合并。 */
function classify(segs: Segment[]): { h: HLine[]; v: VLine[] } {
  const h: HLine[] = [];
  const v: VLine[] = [];
  for (const s of segs) {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dy < 1 && dx > 3) h.push({ y: (s.y1 + s.y2) / 2, x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2) });
    else if (dx < 1 && dy > 3) v.push({ x: (s.x1 + s.x2) / 2, y1: Math.min(s.y1, s.y2), y2: Math.max(s.y1, s.y2) });
  }
  return { h: mergeH(h), v: mergeV(v) };
}

/** 位置相同（相差不超过 TOL）的线归为一组，组内把首尾相接或重叠的线段连成一条。 */
function mergeLines<T>(lines: T[], pos: (l: T) => number, lo: (l: T) => number, hi: (l: T) => number, make: (p: number, a: number, b: number) => T): T[] {
  const sorted = [...lines].sort((a, b) => pos(a) - pos(b));
  const groups: T[][] = [];
  for (const l of sorted) {
    const g = groups.at(-1);
    if (g && pos(l) - pos(g[0]) <= TOL) g.push(l);
    else groups.push([l]);
  }
  const out: T[] = [];
  for (const g of groups) {
    const p = g.reduce((s, l) => s + pos(l), 0) / g.length;
    const spans = g.map((l) => [lo(l), hi(l)]).sort((a, b) => a[0] - b[0]);
    let [a, b] = spans[0];
    for (const [c, d] of spans.slice(1)) {
      if (c <= b + TOL) b = Math.max(b, d);
      else {
        out.push(make(p, a, b));
        [a, b] = [c, d];
      }
    }
    out.push(make(p, a, b));
  }
  return out;
}

const mergeH = (lines: HLine[]) => mergeLines(lines, (l) => l.y, (l) => l.x1, (l) => l.x2, (y, x1, x2) => ({ y, x1, x2 }));
const mergeV = (lines: VLine[]) => mergeLines(lines, (l) => l.x, (l) => l.y1, (l) => l.y2, (x, y1, y2) => ({ x, y1, y2 }));

function cluster(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    const last = out.at(-1);
    if (last === undefined || v - last > TOL) out.push(v);
  }
  return out;
}

export interface TableGrid {
  /** 列分隔线的 x，从左到右 */
  xs: number[];
  /** 行分隔线的 y，从上到下（PDF 坐标 y 向上，所以从大到小） */
  ys: number[];
  h: HLine[];
  v: VLine[];
  box: { x1: number; y1: number; x2: number; y2: number };
}

/** 横线与竖线相交连成的一组线 = 一张表。至少 2 条横线、2 条竖线，且有 2 个以上的格子，才算表格。 */
export function findTables(segs: Segment[]): TableGrid[] {
  const { h, v } = classify(segs);
  const n = h.length + v.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < h.length; i++)
    for (let j = 0; j < v.length; j++) {
      const a = h[i];
      const b = v[j];
      if (b.x >= a.x1 - TOL && b.x <= a.x2 + TOL && a.y >= b.y1 - TOL && a.y <= b.y2 + TOL) union(i, h.length + j);
    }
  const groups = new Map<number, { h: HLine[]; v: VLine[] }>();
  h.forEach((l, i) => {
    const g = groups.get(find(i)) ?? { h: [], v: [] };
    g.h.push(l);
    groups.set(find(i), g);
  });
  v.forEach((l, j) => {
    const g = groups.get(find(h.length + j)) ?? { h: [], v: [] };
    g.v.push(l);
    groups.set(find(h.length + j), g);
  });
  const out: TableGrid[] = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const xs = cluster(g.v.map((l) => l.x));
    const ys = cluster(g.h.map((l) => l.y)).reverse();
    if (xs.length < 2 || ys.length < 2 || (xs.length - 1) * (ys.length - 1) < 2) continue;
    out.push({ xs, ys, h: g.h, v: g.v, box: { x1: xs[0], x2: xs.at(-1)!, y1: ys.at(-1)!, y2: ys[0] } });
  }
  return out;
}

// ---------------------------------------------------------------- 文字放进单元格

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  eol: boolean;
}

function toItems(raw: unknown[]): Item[] {
  return raw.filter(isTextItem).map((it: TextItemLike) => ({
    str: it.str,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width,
    size: Math.abs(it.transform[3]) || it.height || 10,
    eol: Boolean(it.hasEOL),
  }));
}

/** 一组文字块按行拼成文字：同一行内按 x 排序，行与行之间不加换行（单元格内是自动折行）。 */
function cellText(items: Item[]): string {
  const sorted = [...items].filter((i) => i.str.trim()).sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.size, b.size) * 0.5 ? b.y - a.y : a.x - b.x));
  let out = '';
  let lastEnd: number | null = null;
  let lastY: number | null = null;
  for (const it of sorted) {
    const newLine = lastY !== null && Math.abs(it.y - lastY) > it.size * 0.5;
    if (out && !newLine && lastEnd !== null && it.x - lastEnd > it.size * 0.9) out += ' ';
    else if (out && newLine && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(it.str)) out += ' ';
    out += it.str;
    lastEnd = it.x + it.w;
    lastY = it.y;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const hasH = (t: TableGrid, y: number, xa: number, xb: number) => t.h.some((l) => Math.abs(l.y - y) <= TOL && l.x1 <= xa + TOL && l.x2 >= xb - TOL);
const hasV = (t: TableGrid, x: number, ya: number, yb: number) => t.v.some((l) => Math.abs(l.x - x) <= TOL && l.y1 <= Math.min(ya, yb) + TOL && l.y2 >= Math.max(ya, yb) - TOL);

const esc = (s: string) => s.replace(/\|/g, '｜');

/** 一张表 → Markdown。合并单元格的文字放在左上角那一格；纵向合并的，下面各行重复这段文字，横向合并的，右边的格子留空。 */
function tableMarkdown(t: TableGrid, items: Item[]): { md: string; used: Set<Item> } {
  const R = t.ys.length - 1;
  const C = t.xs.length - 1;
  const id = (r: number, c: number) => r * C + c;
  const parent = Array.from({ length: R * C }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const top = t.ys[r];
      const bottom = t.ys[r + 1];
      const left = t.xs[c];
      const right = t.xs[c + 1];
      // 右边没有竖线 → 与右边的格子是同一个单元格
      if (c + 1 < C && !hasV(t, right, top - (top - bottom) * 0.25, bottom + (top - bottom) * 0.25)) parent[find(id(r, c + 1))] = find(id(r, c));
      // 下边没有横线 → 与下面的格子是同一个单元格
      if (r + 1 < R && !hasH(t, bottom, left + (right - left) * 0.25, right - (right - left) * 0.25)) parent[find(id(r + 1, c))] = find(id(r, c));
    }
  const cellItems = new Map<number, Item[]>();
  const used = new Set<Item>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.size * 0.3;
    if (cx < t.box.x1 || cx > t.box.x2 || cy < t.box.y1 || cy > t.box.y2) continue;
    const c = t.xs.findIndex((x, k) => k < C && cx >= x && cx <= t.xs[k + 1]);
    const r = t.ys.findIndex((y, k) => k < R && cy <= y && cy >= t.ys[k + 1]);
    if (c < 0 || r < 0) continue;
    const root = find(id(r, c));
    const list = cellItems.get(root) ?? [];
    list.push(it);
    cellItems.set(root, list);
    used.add(it);
  }
  const rows: string[][] = [];
  for (let r = 0; r < R; r++) {
    const row: string[] = [];
    for (let c = 0; c < C; c++) {
      const root = find(id(r, c));
      const [r0, c0] = [Math.floor(root / C), root % C];
      // 合并单元格：左上角那格放文字；同一列往下被合并的格子重复这段文字（看表格时一行就是一条完整记录），往右被合并的留空
      row.push(c0 === c ? esc(cellText(cellItems.get(root) ?? [])) : '');
      void r0;
    }
    rows.push(row);
  }
  // 去掉全空的行和列（表格线画出来的空隙）
  const keepCols = Array.from({ length: C }, (_, c) => rows.some((row) => row[c]));
  const body = rows.map((row) => row.filter((_, c) => keepCols[c])).filter((row) => row.some(Boolean));
  // 只有一列的不算表格（常见的是段落底纹、文本框），按普通文字输出
  if (body.length < 2 || body[0].length < 2) return { md: '', used: new Set() };
  const width = body[0].length;
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  const md = [line(body[0]), line(Array(width).fill('---')), ...body.slice(1).map(line)].join('\n');
  return { md, used };
}

// ---------------------------------------------------------------- 一页 → Markdown

/** 表格以外的文字：按坐标分行（与 pageItemsToText 相同的规则），记下每行的 y，便于和表格按位置排序。 */
function flowLines(items: Item[]): { y: number; text: string }[] {
  const lines: { y: number; text: string }[] = [];
  let line = '';
  let lineY = 0;
  let lastY: number | null = null;
  let lastEnd = 0;
  const flush = () => {
    if (line.trim()) lines.push({ y: lineY, text: line.replace(/\s+$/, '') });
    line = '';
  };
  for (const it of items) {
    if (lastY !== null && Math.abs(it.y - lastY) > it.size * 0.5) {
      flush();
      lastEnd = 0;
    } else if (line && it.x - lastEnd > it.size * 0.9) line += ' ';
    if (!line) lineY = it.y;
    line += it.str;
    lastY = it.y;
    lastEnd = it.x + it.w;
    if (it.eol) {
      flush();
      lastY = null;
      lastEnd = 0;
    }
  }
  flush();
  return lines;
}

/** 一页的 Markdown：表格按单元格还原，其余文字逐行保留。没有表格线的页，结果与 pageItemsToText 相同。 */
export function pageToMarkdown(rawItems: unknown[], segments: Segment[]): { markdown: string; tables: number } {
  const items = toItems(rawItems);
  const tables = findTables(segments);
  const blocks: { y: number; text: string }[] = [];
  const used = new Set<Item>();
  for (const t of tables) {
    const r = tableMarkdown(t, items);
    if (!r.md) continue;
    r.used.forEach((i) => used.add(i));
    blocks.push({ y: t.box.y2, text: `\n${r.md}\n` });
  }
  const rest = items.filter((i) => !used.has(i));
  for (const l of flowLines(rest)) blocks.push(l);
  // 按位置从上到下排；同一高度保持原有先后
  const ordered = blocks.map((b, i) => ({ ...b, i })).sort((a, b) => (Math.abs(a.y - b.y) < 1 ? a.i - b.i : b.y - a.y));
  const markdown = ordered
    .map((b) => b.text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, tables: tables.length };
}
