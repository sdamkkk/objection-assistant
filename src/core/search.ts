// 分段检索：对 Markdown 分段做 BM25 打分。中文不分词，按单字加相邻两字切分，
// 这样问题和原文用词不完全一致时（"成立" 与 "生效"、"手续费" 与 "佣金" 除外），仍能靠共有的字和词靠近。
// 与 scripts/eval-retrieval.py 中的实现保持一致，评测结果才能代表线上效果。

import { normalize } from './textfind.ts';

export interface Chunk {
  /** 分段编号：<文件编号>#<序号> */
  id: string;
  doc: string;
  title: string;
  /** 所在的标题路径，如 "§10 基金份额的申购赎回 > 10.4 申购和赎回的数额限制" */
  heading: string;
  /** 起止页码（与原件页码一致；Word 原件为章的序号） */
  page: number;
  page_to: number;
  /** Markdown 原文 */
  text: string;
}

const CJK = /[一-鿿]/;
const STOP = new Set('的了吗呢吧啊是在有和与及或这那什么怎么多少哪些哪个能不会要还'.split(''));

/** 去掉 Markdown 记号后归一化（去空白、全角转半角）。 */
export function plain(md: string): string {
  return normalize(md.replace(/<br>/g, '').replace(/^\|?\s*:?-{3,}.*$/gm, '').replace(/[|#*]/g, '')).text;
}

export function tokens(s: string): string[] {
  const n = normalize(s).text;
  const out: string[] = [];
  for (const ch of n) if (CJK.test(ch) && !STOP.has(ch)) out.push(ch);
  for (let i = 0; i < n.length - 1; i++) if (CJK.test(n[i]) && CJK.test(n[i + 1])) out.push(n.slice(i, i + 2));
  for (const m of n.matchAll(/\d+(?:\.\d+)?%?|[a-zA-Z]+/g)) out.push(m[0]);
  return out;
}

function counts(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export class Bm25Index {
  private readonly tf: Map<string, number>[];
  private readonly len: number[];
  private readonly avg: number;
  private readonly idf = new Map<string, number>();
  readonly plainText: string[];
  readonly chunks: Chunk[];
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.plainText = chunks.map((c) => plain(c.text));
    this.tf = chunks.map((c) => counts(tokens(`${c.title} ${c.heading} ${c.text}`)));
    this.len = this.tf.map((t) => [...t.values()].reduce((a, b) => a + b, 0));
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
    const df = new Map<string, number>();
    for (const t of this.tf) for (const w of t.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    const n = chunks.length;
    for (const [w, c] of df) this.idf.set(w, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  }

  /** 返回按得分从高到低的分段下标。filter 为 false 的分段不参与。 */
  rank(query: string, filter?: (c: Chunk) => boolean): { i: number; score: number }[] {
    const q = counts(tokens(query));
    const out: { i: number; score: number }[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      if (filter && !filter(this.chunks[i])) continue;
      const tf = this.tf[i];
      let s = 0;
      for (const w of q.keys()) {
        const f = tf.get(w);
        if (!f) continue;
        s += (this.idf.get(w) ?? 0) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avg)));
      }
      if (s > 0) out.push({ i, score: s });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

/** 从分段里挑出与问题最相关的两句（按原文顺序），作为检索结果的片段。 */
export function bestSnippet(md: string, query: string, max = 220): string {
  const q = new Set(tokens(query).filter((t) => t.length > 1 || /\d/.test(t)));
  const text = md.replace(/<br>/g, '').replace(/^\|?\s*:?-{3,}.*$/gm, '').replace(/\*\*/g, '');
  const sentences = text.split(/(?<=[。；\n])/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const scored = sentences.map((s, i) => ({ s, i, score: tokens(s).filter((x) => q.has(x)).length }));
  const pick = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 2).sort((a, b) => a.i - b.i);
  const out = pick.map((p, k) => (k > 0 && p.i !== pick[k - 1].i + 1 ? '… ' : '') + p.s).join(' ');
  return out.length > max ? out.slice(0, max) + '…' : out;
}

/** 相邻两字的集合，用于判断两段文字是否几乎一样。 */
export function bigramSet(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 两段文字的重合程度：共有的两字组合占较短一段的比例。 */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const g of small) if (big.has(g)) n += 1;
  return n / small.size;
}

// ---------------------------------------------------------------- 向量检索

export interface EmbeddingMeta {
  model: string;
  dim: number;
  count: number;
  fingerprint?: string;
  /** 每个向量的缩放系数（int8 量化） */
  scale: number[];
}

/** 构建时预先算好的分段向量（int8 量化）。 */
export class VectorIndex {
  readonly dim: number;
  readonly count: number;
  private readonly data: Int8Array;
  private readonly scale: Float32Array;

  constructor(meta: EmbeddingMeta, data: Int8Array) {
    if (data.length !== meta.dim * meta.count) throw new Error(`向量数据长度不对：${data.length} ≠ ${meta.dim}×${meta.count}`);
    this.dim = meta.dim;
    this.count = meta.count;
    this.data = data;
    this.scale = Float32Array.from(meta.scale);
  }

  /** 与问题向量的余弦相似度（问题向量会先归一化）。 */
  similarities(query: ArrayLike<number>, filter?: (i: number) => boolean): { i: number; score: number }[] {
    if (query.length !== this.dim) throw new Error(`问题向量维度 ${query.length}，分段向量维度 ${this.dim}`);
    let norm = 0;
    for (let k = 0; k < this.dim; k++) norm += query[k] * query[k];
    norm = Math.sqrt(norm) || 1;
    const out: { i: number; score: number }[] = [];
    for (let i = 0; i < this.count; i++) {
      if (filter && !filter(i)) continue;
      let dot = 0;
      const base = i * this.dim;
      for (let k = 0; k < this.dim; k++) dot += this.data[base + k] * query[k];
      out.push({ i, score: (dot * this.scale[i]) / norm });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

/** 倒数排名融合：几种排序各自的名次换算成分数后相加。weights 与 rankings 一一对应。 */
export function fuseRanks(rankings: number[][], weights: number[], k = 60): Map<number, number> {
  const agg = new Map<number, number>();
  rankings.forEach((list, r) => {
    list.forEach((i, rank) => agg.set(i, (agg.get(i) ?? 0) + (weights[r] ?? 1) / (k + rank + 1)));
  });
  return agg;
}
