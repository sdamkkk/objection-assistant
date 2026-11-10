// 运行一次处理：创建会话、接收引擎事件、保存结果。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Session, type RoundRecord, type SessionOutcome } from '../core/engine.ts';
import { createHttpModel } from '../core/http-model.ts';
import type { ToolLogEntry } from '../core/types.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../shared/knowledge.generated.ts';
import type { KnowledgeBase } from '../core/kb.ts';
import { openLibraries, type NoticeMeta } from './library.ts';
import { saveHistory, type HistoryEntry } from './storage.ts';
import { applyEvent, type TimelineEntry } from './timeline.ts';

export type RunStatus = 'idle' | 'running' | 'done' | 'error';

export interface RunState {
  id: string;
  status: RunStatus;
  noticeTitle: string;
  noticeText: string;
  /** 当前公告的信息（用于引用定位） */
  notice?: NoticeMeta;
  /** 上传的 PDF 原件（不保存） */
  fileData?: ArrayBuffer;
  /** 本次使用的文件库 */
  libs?: { kb?: KnowledgeBase; rules?: KnowledgeBase };
  requests: string[];
  timeline: TimelineEntry[];
  rounds: RoundRecord[];
  toolLog: ToolLogEntry[];
  outcome: SessionOutcome | null;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** 从历史记录打开的，只能查看，不能追问 */
  readOnly?: boolean;
}

const EMPTY: RunState = {
  id: '',
  status: 'idle',
  noticeTitle: '',
  noticeText: '',
  requests: [],
  timeline: [],
  rounds: [],
  toolLog: [],
  outcome: null,
  startedAt: 0,
};

export interface RunOptions {
  thinking: boolean;
  model?: string;
}

export function useRunner(getAccessCode: () => string, onSaved?: (list: HistoryEntry[]) => void, getRunOptions?: () => RunOptions) {
  const [state, setState] = useState<RunState>(EMPTY);
  // 每次开始处理或追问时，取一次界面上的模型和深度思考设置
  const optsRef = useRef<RunOptions | undefined>(undefined);
  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const savedRef = useRef('');

  // 每次运行结束后保存一次历史记录
  useEffect(() => {
    if (state.readOnly || (state.status !== 'done' && state.status !== 'error') || !state.finishedAt) return;
    const key = `${state.id}:${state.finishedAt}`;
    if (savedRef.current === key) return;
    savedRef.current = key;
    const list = saveHistory({
      id: state.id,
      at: state.startedAt,
      noticeTitle: state.noticeTitle,
      noticeText: state.noticeText,
      notice: state.notice,
      requests: state.requests,
      outcome: state.outcome,
      rounds: state.rounds,
      toolLog: state.toolLog,
      timeline: state.timeline
        .filter((t) => t.kind !== 'model' || t.status === 'done')
        .map((t) => (t.kind === 'model' && t.reasoning && t.reasoning.length > 6000 ? { ...t, reasoning: `${t.reasoning.slice(0, 6000)}…` } : t)),
      error: state.error,
      durationMs: state.finishedAt - state.startedAt,
    });
    onSaved?.(list);
  }, [state, onSaved]);

  const run = useCallback(async (session: Session, job: () => Promise<SessionOutcome>, base: RunState) => {
    setState(base);
    try {
      const outcome = await job();
      setState((s) => ({ ...s, status: 'done', outcome, rounds: [...session.rounds], toolLog: [...session.toolLog], finishedAt: Date.now() }));
    } catch (e) {
      const aborted = e instanceof Error && /取消|abort/i.test(e.message + e.name);
      const msg = aborted ? '已停止处理' : e instanceof Error ? e.message : String(e);
      setState((s) => ({
        ...s,
        status: 'error',
        error: msg,
        rounds: [...session.rounds],
        toolLog: [...session.toolLog],
        finishedAt: Date.now(),
        timeline: [...s.timeline, { id: Date.now(), kind: 'error', text: msg, at: Date.now() }],
      }));
    } finally {
      abortRef.current = null;
    }
  }, []);

  const start = useCallback(
    async (notice: NoticeMeta & { fileData?: ArrayBuffer }, request: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      optsRef.current = getRunOptions?.();
      const { fileData, ...meta } = notice;
      const noticeText = meta.pages?.length ? meta.pages.join('\n\n') : meta.text;
      const libs = await openLibraries(meta);
      const session = new Session({
        noticeText,
        noticePages: meta.pages,
        noticeView: meta.markdown,
        kb: libs.kb,
        rules: libs.rules,
        callModel: createHttpModel({ getAccessCode, getOptions: () => optsRef.current ?? {} }),
        references: REFERENCES,
        products: PRODUCTS.products,
        calendar: CALENDAR,
        signal: controller.signal,
        onEvent: (e) => {
          setState((s) => {
            const timeline = applyEvent(s.timeline, e);
            const refresh = e.type === 'submitted' || e.type === 'reviewed' || e.type === 'tool';
            return refresh ? { ...s, timeline, rounds: [...session.rounds], toolLog: [...session.toolLog] } : { ...s, timeline };
          });
        },
      });
      sessionRef.current = session;
      const base: RunState = {
        ...EMPTY,
        id: `run-${Date.now()}`,
        status: 'running',
        noticeTitle: meta.title,
        noticeText,
        notice: meta,
        fileData,
        libs,
        requests: [request],
        startedAt: Date.now(),
        timeline: libs.warning ? [{ id: Date.now(), kind: 'error', text: libs.warning, at: Date.now() }] : [],
      };
      void run(session, () => session.start(request), base);
    },
    [getAccessCode, getRunOptions, run],
  );

  const followUp = useCallback(
    (text: string) => {
      const session = sessionRef.current;
      if (!session) return;
      const controller = new AbortController();
      abortRef.current = controller;
      optsRef.current = getRunOptions?.();
      session.setSignal(controller.signal);
      const s = stateRef.current;
      const base: RunState = { ...s, status: 'running', requests: [...s.requests, text], error: undefined, outcome: null, finishedAt: undefined };
      void run(session, () => session.followUp(text), base);
    },
    [run, getRunOptions],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const open = useCallback((h: HistoryEntry) => {
    sessionRef.current = null;
    setState({
      id: h.id,
      status: h.outcome ? 'done' : 'error',
      noticeTitle: h.noticeTitle,
      noticeText: h.noticeText,
      notice: h.notice ?? { title: h.noticeTitle, text: h.noticeText, origin: '历史记录' },
      requests: h.requests,
      timeline: h.timeline,
      rounds: h.rounds,
      toolLog: h.toolLog,
      outcome: h.outcome,
      error: h.error,
      startedAt: h.at,
      finishedAt: h.at + h.durationMs,
      readOnly: true,
    });
  }, []);

  const reset = useCallback(() => {
    sessionRef.current = null;
    setState(EMPTY);
  }, []);

  return { state, start, followUp, stop, open, reset, hasSession: () => Boolean(sessionRef.current) };
}
