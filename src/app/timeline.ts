// 把引擎事件整理成"过程记录"里的条目。

import type { EngineEvent } from '../core/engine.ts';
import type { AgentRole, ReviewResult, ToolLogEntry } from '../core/types.ts';

export type TimelineEntry =
  | { id: number; kind: 'phase'; agent: AgentRole; round: number; label: string; at: number }
  | {
      id: number;
      kind: 'model';
      agent: AgentRole;
      round: number;
      step: number;
      status: 'running' | 'done';
      reasoningChars: number;
      contentChars: number;
      toolArgsChars: number;
      ms?: number;
      text?: string;
      /** 思维链 */
      reasoning?: string;
      toolCalls?: string[];
      at: number;
    }
  | { id: number; kind: 'tool'; agent: AgentRole; round: number; entry: ToolLogEntry; at: number }
  | { id: number; kind: 'warn'; agent: AgentRole; round: number; text: string; at: number }
  | { id: number; kind: 'submitted'; agent: AgentRole; round: number; at: number }
  | { id: number; kind: 'review'; agent: 'review'; round: number; review: ReviewResult; willRework: boolean; at: number }
  | { id: number; kind: 'error'; agent?: AgentRole; round?: number; text: string; at: number };

let seq = 0;
const nextId = () => ++seq;

export function applyEvent(list: TimelineEntry[], e: EngineEvent): TimelineEntry[] {
  const at = Date.now();
  switch (e.type) {
    case 'phase':
      return [...list, { id: nextId(), kind: 'phase', agent: e.agent, round: e.round, label: e.label, at }];
    case 'model_start':
      return [
        ...list,
        { id: nextId(), kind: 'model', agent: e.agent, round: e.round, step: e.step, status: 'running', reasoningChars: 0, contentChars: 0, toolArgsChars: 0, at },
      ];
    case 'model_progress':
    case 'model_done': {
      const idx = findLastIndex(list, (x) => x.kind === 'model' && x.agent === e.agent && x.round === e.round && x.step === e.step);
      if (idx < 0) return list;
      const cur = list[idx] as Extract<TimelineEntry, { kind: 'model' }>;
      const next: TimelineEntry =
        e.type === 'model_progress'
          ? { ...cur, reasoning: e.reasoning ?? cur.reasoning, reasoningChars: e.reasoningChars, contentChars: e.contentChars, toolArgsChars: e.toolArgsChars }
          : { ...cur, status: 'done' as const, ms: e.ms, text: e.text, reasoning: e.reasoning ?? cur.reasoning, toolCalls: e.toolCalls };
      const copy = list.slice();
      copy[idx] = next;
      return copy;
    }
    case 'tool':
      return [...list, { id: nextId(), kind: 'tool', agent: e.agent, round: e.round, entry: e.entry, at }];
    case 'submit_invalid':
      return [...list, { id: nextId(), kind: 'warn', agent: e.agent, round: e.round, text: `提交的结构不合格，已要求修正：${e.errors.slice(0, 3).join('；')}${e.errors.length > 3 ? ` 等 ${e.errors.length} 处` : ''}`, at }];
    case 'nudge':
      return [...list, { id: nextId(), kind: 'warn', agent: e.agent, round: e.round, text: `模型${e.reason}，已提醒它调用工具提交`, at }];
    case 'submitted':
      return [...list, { id: nextId(), kind: 'submitted', agent: e.agent, round: e.round, at }];
    case 'reviewed':
      return [...list, { id: nextId(), kind: 'review', agent: 'review', round: e.round, review: e.review, willRework: e.willRework, at }];
    case 'review_error':
      return [...list, { id: nextId(), kind: 'error', agent: 'review', round: e.round, text: `检查环节没有完成：${e.error}`, at }];
    default:
      return list;
  }
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

export const TOOL_LABELS: Record<string, string> = {
  read_reference: '读取资料',
  get_product: '查产品事实卡',
  find_quote: '核对引用',
  search_notices: '检索公告库',
  search_rules: '检索规则库',
  read_document: '阅读原文',
  read_notice: '阅读原文',
  calculate: '计算',
  trading_day: '交易日',
  compare: '比较',
  submit_result: '提交结果',
  submit_review: '提交检查',
};

/** 工具调用的一句话摘要，供过程记录和来源面板使用。 */
export function summarizeTool(entry: ToolLogEntry): { args: string; result: string } {
  const a = (entry.args ?? {}) as Record<string, unknown>;
  const r = (entry.result ?? {}) as Record<string, unknown>;
  if (r.error) return { args: JSON.stringify(a), result: `出错：${String(r.error)}` };
  switch (entry.name) {
    case 'read_reference':
      return { args: String(a.name ?? ''), result: r.name ? `已读取 ${String(r.name)}` : '' };
    case 'get_product': {
      const missing = Array.isArray(r.not_provided) ? (r.not_provided as unknown[]).length : 0;
      return { args: String(a.name ?? a.code ?? ''), result: r.found ? `找到产品事实卡${missing ? `，其中 ${missing} 项未提供` : ''}` : '产品库中没有该产品' };
    }
    case 'find_quote': {
      const where = a.doc_id || a.notice_id ? `${String(a.doc_id ?? a.notice_id)} ` : '';
      const loc = [r.location, r.article].filter(Boolean).join(' ');
      return {
        args: `${where}“${String(a.text ?? '')}”`,
        result: r.found ? `${where ? '原文' : '案例材料'}中找到${loc ? `（${loc}）` : ''}` : r.closest ? `没找到，最接近的是“${String(r.closest)}”` : '没找到',
      };
    }
    case 'search_notices':
    case 'search_rules': {
      const kw = Array.isArray(a.keywords) ? (a.keywords as unknown[]).join('、') : String(a.keywords ?? '');
      const q = typeof a.query === 'string' && a.query.trim() ? `“${a.query.trim()}”` : '';
      const types = Array.isArray(a.types) && a.types.length ? `（${(a.types as unknown[]).join('、')}）` : '';
      if (r.mode === 'list') return { args: `列出文件${types}`, result: `${String(r.count)} 份` };
      const res = (r.results as { id: string; page: number; section?: string }[] | undefined) ?? [];
      const head = [q, kw && `关键词：${kw}`].filter(Boolean).join(' ');
      if (r.total_pages_matched !== undefined) {
        return { args: `${head}${types}`, result: res.length ? `命中 ${String(r.total_pages_matched)} 页，前几条：${res.slice(0, 4).map((x) => `${x.id} 第${x.page}页`).join('、')}` : '没有命中' };
      }
      const how = r.method ? `（${String(r.method)}）` : '';
      return { args: `${head}${types}`, result: res.length ? `前几条${how}：${res.slice(0, 4).map((x) => `${x.id} 第${x.page}页`).join('、')}` : '没有找到' };
    }
    case 'read_document':
    case 'read_notice':
      if (r.format === 'markdown') return { args: String(a.section || a.id || ''), result: `读取 ${String(r.title ?? '')} ${String(r.sections ?? '')}${r.truncated ? '（未读完）' : ''}` };
      return { args: String(a.id ?? ''), result: `读取 ${String(r.title ?? '')} 第 ${String(r.page_from)}–${String(r.page_to)} 页${r.truncated ? '（未读完）' : ''}` };
    case 'calculate': {
      const label = a.label ? `${String(a.label)}：` : '';
      return { args: `${label}${String(r.substituted ?? a.expression ?? '')}`, result: `= ${String(r.result_grouped ?? r.result ?? '')}${r.rounding ? `（保留 ${String(r.decimals)} 位，${String(r.rounding)}）` : ''}` };
    }
    case 'trading_day': {
      const op = String(a.op ?? '');
      if (op === 'acceptance_date') return { args: `${String(a.datetime ?? '')} 提交的申请`, result: String(r.explanation ?? r.acceptance_date ?? '') };
      if (op === 'is_trading_day') return { args: String(r.date ?? a.date ?? ''), result: r.is_trading_day ? '是交易日' : `不是交易日（${String(r.reason)}）` };
      if (op === 'next_trading_day') return { args: `${String(r.date ?? a.date)} 的下一个交易日`, result: String(r.next_trading_day ?? '') };
      if (op === 'previous_trading_day') return { args: `${String(r.date ?? a.date)} 的上一个交易日`, result: String(r.previous_trading_day ?? '') };
      return { args: `${String(r.date ?? a.date)} 加 ${String(a.days)} 个交易日`, result: String(r.result ?? '') };
    }
    case 'compare':
      return { args: a.label ? String(a.label) : String(a.op ?? ''), result: String(r.explanation ?? '') };
    default:
      return { args: JSON.stringify(a), result: JSON.stringify(r) };
  }
}
