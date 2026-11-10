// 建文件库：从原始文件中提取每一页的文字，生成检索用的索引。原始文件本身不做任何修改，随网站一起发布。
//
// 用法：
//   node scripts/build-library.ts fund 159212   基金公告库（kb-src/159212/list.tsv + public/kb/159212/pdf/*.pdf）
//   node scripts/build-library.ts rules         规则库（kb-src/rules/manifest.json + public/kb/rules/files/*）
//
// 输出（public/kb/<库编号>/）：index.json 文件清单；pages.json 每页文字；text/<编号>.json 每份文件的分页文字。
// 文字提取统一用 pdf.js（与浏览器里查看原文、高亮引用用的是同一套），Word 原件用 LibreOffice 转成文字。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { KbIndex, KbItem, KbPage } from '../src/core/kb.ts';
import { pageItemsToText } from '../src/core/pdftext.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB = join(root, 'public', 'kb');
const pdfjsDir = join(root, 'node_modules', 'pdfjs-dist');

async function pdfPages(file: string): Promise<string[]> {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(file)),
    cMapUrl: pathToFileURL(join(pdfjsDir, 'cmaps')).href + '/',
    cMapPacked: true,
    standardFontDataUrl: pathToFileURL(join(pdfjsDir, 'standard_fonts')).href + '/',
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(pageItemsToText(content.items));
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

/** Word 原件：用 LibreOffice 转成 UTF-8 文字，按"第X章"切成若干段。 */
function docChapters(file: string): { label: string; text: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'doc-'));
  const src = join(dir, 'source.doc');
  writeFileSync(src, readFileSync(file));
  execFileSync('soffice', ['--headless', '--convert-to', 'txt:Text (encoded):UTF8', src, '--outdir', dir], { stdio: 'ignore', timeout: 180000 });
  const text = readFileSync(join(dir, 'source.txt'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  rmSync(dir, { recursive: true, force: true });
  const lines = text.split('\n');
  const chunks: { label: string; text: string }[] = [];
  let cur: { label: string; lines: string[] } = { label: '标题', lines: [] };
  for (const line of lines) {
    const m = /^\s*(第[一二三四五六七八九十百零]+章)\s*(.*)$/.exec(line);
    if (m) {
      if (cur.lines.join('').trim()) chunks.push({ label: cur.label, text: cur.lines.join('\n').trim() });
      cur = { label: `${m[1]} ${m[2].replace(/\s+/g, '')}`.trim(), lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) chunks.push({ label: cur.label, text: cur.lines.join('\n').trim() });
  return chunks;
}

function writeLibrary(code: string, index: KbIndex, pagesOut: KbPage[], perDoc: Map<string, string[]>): void {
  const dst = join(KB, code);
  mkdirSync(join(dst, 'text'), { recursive: true });
  writeFileSync(join(dst, 'index.json'), JSON.stringify(index, null, 1));
  writeFileSync(join(dst, 'pages.json'), JSON.stringify(pagesOut));
  for (const [id, pages] of perDoc) writeFileSync(join(dst, 'text', `${id}.json`), JSON.stringify(pages));
  const catalogPath = join(KB, 'catalog.json');
  const catalog: { code: string; name: string; count: number; kind?: string }[] = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : [];
  const next = catalog.filter((c) => c.code !== code);
  next.push({ code, name: index.name, count: index.count, kind: index.kind ?? 'fund' });
  writeFileSync(catalogPath, JSON.stringify(next, null, 1));
  const chars = index.items.reduce((s, x) => s + x.chars, 0);
  console.log(`${code} ${index.name}: ${index.items.length} 份，${pagesOut.length} 页（段），${chars} 字`);
}

// ---------------------------------------------------------------- 基金公告库

const RULES: [string, string, RegExp][] = [
  ['法律文件', '产品基本资料', /产品基本资料/],
  ['法律文件', '基金合同', /基金合同(?!生效|及)/],
  ['法律文件', '托管协议', /托管协议/],
  ['法律文件', '招募说明书', /招募说明书(?!提示)/],
  ['法律文件', '产品资料概要', /产品资料概要/],
  ['定期报告', '年度报告', /年度报告/],
  ['定期报告', '中期报告', /中期报告/],
  ['定期报告', '季度报告', /季度报告/],
  ['临时公告', '基金经理变更', /基金经理/],
  ['临时公告', '发售', /发售公告/],
  ['临时公告', '募集规模限制', /募集规模限制/],
  ['临时公告', '合同生效', /合同生效/],
  ['临时公告', '上市交易', /上市交易/],
  ['临时公告', '开放申购赎回', /开放日常申购/],
  ['临时公告', '流动性服务商', /流动性服务商/],
  ['临时公告', '一级交易商', /一级交易商/],
  ['临时公告', '关联交易', /关联交易/],
  ['临时公告', '获配非公开发行', /非公开发行/],
  ['临时公告', '提示性公告', /提示性公告/],
  ['临时公告', '限购与暂停交易', /限制大额|暂停.*(申购|赎回)|恢复.*(申购|赎回)/],
  ['临时公告', '分红', /分红/],
];

function classify(title: string): [string, string] {
  for (const [big, small, re] of RULES) if (re.test(title)) return [big, small];
  return ['临时公告', '其他'];
}

function sentDate(text: string, fallback: string): string {
  const m = /送出日期[:：]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : fallback;
}

async function buildFund(code: string): Promise<void> {
  const rows = readFileSync(join(root, 'kb-src', code, 'list.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t'));
  const n = rows.length;
  const items: KbItem[] = [];
  const pagesOut: KbPage[] = [];
  const perDoc = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    const [pub, title, url] = rows[i];
    const no = n - i;
    const nn = String(no).padStart(2, '0');
    const rel = `pdf/${nn}_${pub}.pdf`;
    const pages = await pdfPages(join(KB, code, rel));
    const full = pages.join('\n\n');
    const [category, type] = classify(title);
    const id = `${code}-${nn}`;
    perDoc.set(id, pages);
    pages.forEach((t, k) => pagesOut.push({ id, page: k + 1, text: t }));
    items.push({
      id,
      no,
      title,
      category,
      type,
      published: pub,
      date: sentDate(full, pub),
      pages: pages.length,
      chars: full.length,
      // 巨潮的相对路径补全成完整地址；以 / 或 http 开头的（如题目材料）照用
      source: /^(https?:)?\//.test(url) ? url : `https://static.cninfo.com.cn/${url}`,
      pdf: rel,
      text: `text/${id}.json`,
    });
  }
  items.sort((a, b) => a.no - b.no);
  // kb-src/<代码>/meta.json 可以指定库名和来源说明；没有时从标题中取基金名称（巨潮下载的库）
  const metaPath = join(root, 'kb-src', code, 'meta.json');
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: string; source?: string }) : {};
  const name = meta.name ?? items[0].title;
  const index: KbIndex = {
    code,
    kind: 'fund',
    name,
    source: meta.source ?? '巨潮资讯网（cninfo.com.cn）基金公告。本站保存的 PDF 是从巨潮下载的原件，未做修改；文字由 pdf.js 从原件中提取，用于检索和定位，以原件为准。',
    count: items.length,
    items,
  };
  writeLibrary(code, index, pagesOut, perDoc);
}

// ---------------------------------------------------------------- 规则库

interface RuleEntry {
  id: string;
  title: string;
  type: string;
  category: string;
  issuer: string;
  docNo: string;
  date: string;
  effective: string;
  status: string;
  file: string;
  pageRange?: [number, number];
  page: string;
  fileUrl: string;
  note?: string;
}

async function buildRules(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(root, 'kb-src', 'rules', 'manifest.json'), 'utf8')) as {
    code: string;
    name: string;
    source: string;
    items: RuleEntry[];
  };
  const dir = join(KB, 'rules');
  const items: KbItem[] = [];
  const pagesOut: KbPage[] = [];
  const perDoc = new Map<string, string[]>();
  manifest.items.forEach((r, i) => {
    if (!existsSync(join(dir, r.file))) throw new Error(`缺少原件：${r.file}`);
  });
  for (const [i, r] of manifest.items.entries()) {
    const file = join(dir, r.file);
    let pages: string[];
    let firstPage = 1;
    let labels: string[] | undefined;
    if (/\.pdf$/i.test(r.file)) {
      const all = await pdfPages(file);
      if (r.pageRange) {
        firstPage = r.pageRange[0];
        pages = all.slice(r.pageRange[0] - 1, r.pageRange[1]);
      } else pages = all;
    } else {
      const chunks = docChapters(file);
      pages = chunks.map((c) => c.text);
      labels = chunks.map((c) => c.label);
    }
    perDoc.set(r.id, pages);
    pages.forEach((t, k) => pagesOut.push({ id: r.id, page: firstPage + k, text: t }));
    const full = pages.join('\n\n');
    items.push({
      id: r.id,
      no: i + 1,
      title: r.title,
      category: r.category,
      type: r.type,
      published: r.date,
      date: r.date,
      effective: r.effective,
      issuer: r.issuer,
      docNo: r.docNo,
      status: r.status,
      pages: pages.length,
      firstPage,
      labels,
      format: /\.pdf$/i.test(r.file) ? 'pdf' : 'doc',
      chars: full.length,
      source: r.fileUrl,
      sourcePage: r.page,
      note: r.note,
      pdf: r.file,
      text: `text/${r.id}.json`,
    });
    console.log(`  ${r.id} ${r.type}：${pages.length} ${labels ? '章' : '页'}，${full.length} 字（${basename(r.file)}）`);
  }
  const index: KbIndex = { code: 'rules', kind: 'rules', name: manifest.name, source: manifest.source, count: items.length, items };
  writeLibrary('rules', index, pagesOut, perDoc);
}

const [kind, arg] = process.argv.slice(2);
if (kind === 'fund' && arg) await buildFund(arg);
else if (kind === 'rules') await buildRules();
else {
  console.error('用法：node scripts/build-library.ts fund <基金代码> | rules');
  process.exit(1);
}
