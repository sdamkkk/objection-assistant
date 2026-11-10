// 浏览器本地存储：口令和最近的处理记录。读写都可能失败（隐私模式等），失败时静默降级。

import type { RoundRecord, SessionOutcome } from '../core/engine.ts';
import type { ToolLogEntry } from '../core/types.ts';
import type { NoticeMeta } from './library.ts';
import type { TimelineEntry } from './timeline.ts';

const CODE_KEY = 'ora.accessCode';
const HISTORY_KEY = 'ora.history.v1';

export function loadCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveCode(code: string): void {
  try {
    localStorage.setItem(CODE_KEY, code);
  } catch {
    /* 忽略 */
  }
}

export interface HistoryEntry {
  id: string;
  at: number;
  noticeTitle: string;
  noticeText: string;
  notice?: NoticeMeta;
  requests: string[];
  outcome: SessionOutcome | null;
  rounds: RoundRecord[];
  toolLog: ToolLogEntry[];
  timeline: TimelineEntry[];
  error?: string;
  durationMs: number;
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(entry: HistoryEntry): HistoryEntry[] {
  let list = loadHistory().filter((h) => h.id !== entry.id);
  list.unshift(entry);
  list = list.slice(0, 8);
  // 超出容量时逐条丢掉最旧的
  while (list.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      return list;
    } catch {
      list.pop();
    }
  }
  return list;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}
