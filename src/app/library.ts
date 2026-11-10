// 浏览器端加载文件库（随网站发布的静态文件），并组装引用定位用的 DocProvider。

import type { DocProvider } from '../core/citations.ts';
import { KnowledgeBase, detectNoticeDate, detectScope, type CatalogEntry, type CitableDoc, type KbData, type KbIndex, type KbScope } from '../core/kb.ts';
import { PagedText } from '../core/paged.ts';
import type { EmbeddingMeta } from '../core/search.ts';
import { loadCode } from './storage.ts';

const cache = new Map<string, Promise<unknown>>();

function getJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`读取 ${url} 失败（${r.status}）`);
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export const loadCatalog = () => getJson<CatalogEntry[]>('/kb/catalog.json');
export const loadIndex = (code: string) => getJson<KbIndex>(`/kb/${code}/index.json`);
export const loadDocPages = (code: string, id: string) => getJson<string[]>(`/kb/${code}/text/${id}.json`);

/** 公告库文件的 Markdown 版本（建库时由原件转换），去掉开头的元信息。取不到时返回 undefined。 */
export async function loadDocMarkdown(code: string, id: string): Promise<string | undefined> {
  try {
    const r = await fetch(`/kb/${code}/md/${id}.md`);
    if (!r.ok) return undefined;
    const md = await r.text();
    return md.replace(/^---\n[\s\S]*?\n---\n/, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function loadLibrary(code: string): Promise<KbData> {
  const [index, pages, chunks] = await Promise.all([
    loadIndex(code),
    getJson<KbData['pages']>(`/kb/${code}/pages.json`),
    getJson<NonNullable<KbData['chunks']>>(`/kb/${code}/chunks.json`).catch(() => undefined),
  ]);
  return { index, pages, chunks, embeddings: await loadEmbeddings(code) };
}

/** 分段向量（可选）：缺失时检索只用 BM25。 */
async function loadEmbeddings(code: string): Promise<KbData['embeddings']> {
  try {
    const [meta, buf] = await Promise.all([
      getJson<EmbeddingMeta>(`/kb/${code}/embeddings.json`),
      fetch(`/kb/${code}/embeddings.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
    ]);
    return { meta, data: new Int8Array(buf) };
  } catch {
    return undefined;
  }
}

/** 向量服务连续出错后，本次页面会话内不再调用。 */
let embedFailures = 0;
const embedCache = new Map<string, Promise<number[]>>();

/** 通过 /api/embed（Workers AI bge-m3）把检索问题转成向量。 */
export function embedQuery(text: string): Promise<number[]> {
  if (embedFailures >= 3) return Promise.reject(new Error('向量服务不可用'));
  let p = embedCache.get(text);
  if (!p) {
    p = fetch('/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': loadCode() },
      body: JSON.stringify({ texts: [text] }),
    })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { vectors?: number[][]; error?: string };
        if (!r.ok || !j.vectors?.[0]) throw new Error(j.error ?? `向量服务出错（${r.status}）`);
        embedFailures = 0;
        return j.vectors[0];
      })
      .catch((e) => {
        embedFailures += 1;
        embedCache.delete(text);
        throw e;
      });
    embedCache.set(text, p);
  }
  return p;
}

const libs = new Map<string, KnowledgeBase>();

/** 按范围组装文件库（同一范围复用同一个实例）。 */
export async function openLibrary(scope: KbScope): Promise<KnowledgeBase> {
  const key = `${scope.code}|${scope.asOf}|${scope.excludeId ?? ''}`;
  const hit = libs.get(key);
  if (hit) return hit;
  const kb = new KnowledgeBase(await loadLibrary(scope.code), scope);
  kb.setEmbedder(embedQuery);
  libs.set(key, kb);
  return kb;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前公告的基本信息（会随历史记录保存，不含二进制内容） */
export interface NoticeMeta {
  title: string;
  text: string;
  pages?: string[];
  /** 按版面还原的 Markdown（有表格的 PDF 才有），给 agent 阅读；核对引用仍用 pages */
  markdown?: string;
  origin: string;
  /** 公告日期（用作时间边界） */
  date?: string;
  /** 关联的公告库 */
  kb?: KbScope;
  /** 原件地址（本站保存的公告库原件或示例文件） */
  fileUrl?: string;
  /** 原件的发布地址 */
  sourceUrl?: string;
}

/** 识别上传或粘贴的公告属于公告库中的哪只基金、哪一天。 */
export async function detectNotice(text: string): Promise<{ date?: string; kb?: KbScope; kbName?: string }> {
  const date = detectNoticeDate(text);
  try {
    const catalog = await loadCatalog();
    const first = detectScope(text, catalog);
    if (!first.code) return { date };
    const index = await loadIndex(first.code);
    const s = detectScope(text, catalog, index);
    return { date, kb: { code: first.code, asOf: s.asOf ?? date ?? today(), excludeId: s.excludeId }, kbName: index.name };
  } catch {
    return { date };
  }
}

/** 本次处理可用的文件库：关联了公告库的，加上本基金的公告库；规则库总是提供。 */
export async function openLibraries(meta: NoticeMeta): Promise<{ kb?: KnowledgeBase; rules?: KnowledgeBase; warning?: string }> {
  const asOf = meta.kb?.asOf ?? meta.date ?? today();
  const out: { kb?: KnowledgeBase; rules?: KnowledgeBase; warning?: string } = {};
  const tasks: Promise<void>[] = [
    openLibrary({ code: 'rules', asOf })
      .then((r) => {
        out.rules = r;
      })
      .catch((e) => {
        out.warning = `规则库没有加载成功：${e instanceof Error ? e.message : String(e)}`;
      }),
  ];
  if (meta.kb) {
    tasks.push(
      openLibrary(meta.kb)
        .then((k) => {
          out.kb = k;
        })
        .catch((e) => {
          out.warning = `公告库没有加载成功：${e instanceof Error ? e.message : String(e)}`;
        }),
    );
  }
  await Promise.all(tasks);
  return out;
}

/** 当前公告作为可引用的文件 */
export function noticeDoc(meta: NoticeMeta, fileData?: ArrayBuffer): CitableDoc {
  const paged = meta.pages?.length ? new PagedText(meta.pages) : PagedText.fromText(meta.text);
  return {
    id: 'notice',
    library: 'notice',
    title: meta.title,
    date: meta.date,
    paged,
    fileUrl: meta.fileUrl,
    fileData,
    format: meta.fileUrl || fileData ? 'pdf' : 'text',
    sourceUrl: meta.sourceUrl,
    location: (i) => ({ page: i, label: `第 ${i} 页` }),
    availability: 'ok',
  };
}

export function makeProvider(meta: NoticeMeta, libsOpen: { kb?: KnowledgeBase; rules?: KnowledgeBase }, fileData?: ArrayBuffer): DocProvider {
  const notice = noticeDoc(meta, fileData);
  return {
    notice,
    get: (id) => libsOpen.kb?.citable(id) ?? libsOpen.rules?.citable(id),
  };
}
