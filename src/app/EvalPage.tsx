// 验证页：批量运行验证用例，导出结果文件。

import { useRef, useState } from 'react';
import { Session, reviewOnce, type SessionOutcome } from '../core/engine.ts';
import { createHttpModel } from '../core/http-model.ts';
import { openLibraries, today } from './library.ts';
import type { ReviewResult, ToolLogEntry } from '../core/types.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../shared/knowledge.generated.ts';
import { EVAL_CASES, FAULTS, runChecks } from './eval-cases.ts';
import { downloadBlob } from './export.ts';
import { sampleNotice } from './samples.ts';
import { saveHistory } from './storage.ts';
import { applyEvent, type TimelineEntry } from './timeline.ts';
import { Spinner, formatDuration } from './ui.tsx';

interface CaseRun {
  key: string;
  caseId: string;
  attempt: number;
  status: 'queued' | 'running' | 'done' | 'error';
  startedAt?: number;
  ms?: number;
  outcome?: SessionOutcome;
  toolLog?: ToolLogEntry[];
  checks?: { label: string; pass: boolean }[];
  error?: string;
  phase?: string;
  usage: { prompt: number; completion: number };
}

interface FaultRun {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  review?: ReviewResult;
  detected?: boolean;
  error?: string;
  ms?: number;
}

const GROUPS = ['规定案例', '边界情况', '越界问题', '泛化测试'] as const;

export function EvalPage({ getCode }: { getCode: () => string }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['Q1']));
  const [repeat, setRepeat] = useState(1);
  const [runs, setRuns] = useState<CaseRun[]>([]);
  const [faults, setFaults] = useState<FaultRun[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const update = (key: string, patch: Partial<CaseRun>) => setRuns((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const runAll = async () => {
    const queue: CaseRun[] = [];
    for (const c of EVAL_CASES) if (selected.has(c.id)) for (let i = 1; i <= repeat; i++) queue.push({ key: `${c.id}#${i}#${Date.now()}`, caseId: c.id, attempt: i, status: 'queued', usage: { prompt: 0, completion: 0 } });
    setRuns(queue);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    for (const item of queue) {
      if (controller.signal.aborted) break;
      const c = EVAL_CASES.find((x) => x.id === item.caseId)!;
      const notice = sampleNotice(c.notice, today());
      const t0 = Date.now();
      update(item.key, { status: 'running', startedAt: t0 });
      let timeline: TimelineEntry[] = [];
      const usage = { prompt: 0, completion: 0 };
      const libs = await openLibraries({ title: notice.label, text: notice.text, origin: notice.origin, date: notice.date });
      const session = new Session({
        noticeText: notice.text,
        rules: libs.rules,
        callModel: createHttpModel({ getAccessCode: getCode }),
        references: REFERENCES,
        products: PRODUCTS.products,
        calendar: CALENDAR,
        signal: controller.signal,
        onEvent: (e) => {
          timeline = applyEvent(timeline, e);
          if (e.type === 'phase') update(item.key, { phase: `${e.agent === 'ops' ? '应答' : '检查'}（第 ${e.round} 轮）` });
          if (e.type === 'model_done' && e.usage) {
            usage.prompt += Number(e.usage.prompt_tokens ?? 0);
            usage.completion += Number(e.usage.completion_tokens ?? 0);
          }
        },
      });
      try {
        let outcome = await session.start(c.request);
        for (const f of c.followUps ?? []) outcome = await session.followUp(f);
        const ms = Date.now() - t0;
        update(item.key, { status: 'done', ms, outcome, toolLog: [...session.toolLog], checks: runChecks(outcome.result, c.checks), usage: { ...usage } });
        saveHistory({
          id: `eval-${item.key}`,
          at: t0,
          noticeTitle: `［验证 ${c.id}］${c.title}`,
          noticeText: notice.text,
          requests: [c.request, ...(c.followUps ?? [])],
          outcome,
          rounds: outcome.rounds,
          toolLog: [...session.toolLog],
          timeline: timeline.filter((t) => t.kind !== 'model' || t.status === 'done'),
          durationMs: ms,
        });
      } catch (e) {
        update(item.key, { status: 'error', ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), toolLog: [...session.toolLog], usage: { ...usage } });
      }
    }
    setBusy(false);
    abortRef.current = null;
  };

  const runFaults = async () => {
    const latestByCase = new Map<string, CaseRun>();
    for (const r of runs) if (r.status === 'done' && r.outcome) latestByCase.set(r.caseId, r);
    setFaults(FAULTS.map((f) => ({ id: f.id, status: latestByCase.has(f.base) ? 'queued' : 'skipped' })));
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    for (const f of FAULTS) {
      const base = latestByCase.get(f.base);
      if (!base?.outcome || controller.signal.aborted) continue;
      const c = EVAL_CASES.find((x) => x.id === f.base)!;
      const notice = sampleNotice(c.notice, today());
      const t0 = Date.now();
      setFaults((l) => l.map((x) => (x.id === f.id ? { ...x, status: 'running' } : x)));
      try {
        const libs = await openLibraries({ title: notice.label, text: notice.text, origin: notice.origin, date: notice.date });
        const { review } = await reviewOnce({
          noticeText: notice.text,
          rules: libs.rules,
          requests: [c.request, ...(c.followUps ?? [])],
          result: f.inject(base.outcome.result),
          toolLog: base.toolLog ?? [],
          callModel: createHttpModel({ getAccessCode: getCode }),
          references: REFERENCES,
          products: PRODUCTS.products,
          calendar: CALENDAR,
          signal: controller.signal,
        });
        const must = review.issues.filter((i) => i.severity === '必须修改');
        const detected = must.some((i) => f.detect.test(`${i.problem}${i.basis}${i.suggestion}`));
        setFaults((l) => l.map((x) => (x.id === f.id ? { ...x, status: 'done', review, detected, ms: Date.now() - t0 } : x)));
      } catch (e) {
        setFaults((l) => l.map((x) => (x.id === f.id ? { ...x, status: 'error', error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 } : x)));
      }
    }
    setBusy(false);
    abortRef.current = null;
  };

  const exportJson = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      note: '自动检查只用关键词粗略判断，最终以人工对照验收标准为准。',
      runs: runs.map((r) => ({
        case: EVAL_CASES.find((c) => c.id === r.caseId),
        attempt: r.attempt,
        status: r.status,
        ms: r.ms,
        usage: r.usage,
        error: r.error,
        checks: r.checks,
        outcome: r.outcome,
        toolLog: r.toolLog,
      })),
      faults: faults.map((f) => ({ fault: FAULTS.find((x) => x.id === f.id)?.title, base: FAULTS.find((x) => x.id === f.id)?.base, ...f })),
    };
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `验证结果_${ts}.json`);
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const done = runs.filter((r) => r.status === 'done');
  const passedReview = done.filter((r) => r.outcome?.status === 'passed').length;
  const checkTotal = done.reduce((n, r) => n + (r.checks?.length ?? 0), 0);
  const checkPass = done.reduce((n, r) => n + (r.checks?.filter((c) => c.pass).length ?? 0), 0);

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-4 py-3 lg:px-6">
          <h1 className="text-[17px] font-semibold">验证页</h1>
          <span className="text-[13px] text-muted">批量运行验证用例；结果同时存入"最近处理"，可回到工作台查看</span>
          <span className="flex-1" />
          <a className="btn btn-quiet text-[13px]" href="#/">
            返回工作台
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-5 lg:px-6">
        <div className="sheet px-5 py-4">
          {GROUPS.map((g) => (
            <div key={g} className="mb-3">
              <div className="mb-1 text-[13.5px] font-semibold text-ink-soft">{g}</div>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {EVAL_CASES.filter((c) => c.group === g).map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5 text-[14px]">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} />
                    <span className="num text-muted">{c.id}</span> {c.title}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rule pt-3">
            <label className="flex items-center gap-1.5 text-[14px]">
              每个用例运行
              <select className="field w-auto py-1" value={repeat} onChange={(e) => setRepeat(Number(e.target.value))} disabled={busy}>
                {[1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              次
            </label>
            <button className="btn btn-primary" disabled={busy || selected.size === 0} onClick={runAll}>
              运行选中的用例（{selected.size * repeat} 次）
            </button>
            <button className="btn" disabled={busy || !runs.some((r) => r.status === 'done')} onClick={runFaults} title="需要先跑完 R1、R2、R3">
              运行注入错误测试
            </button>
            {busy && (
              <button className="btn" onClick={() => abortRef.current?.abort()}>
                停止
              </button>
            )}
            <span className="flex-1" />
            <button className="btn" disabled={!runs.length && !faults.length} onClick={exportJson}>
              导出结果 JSON
            </button>
          </div>
        </div>

        {runs.length > 0 && (
          <div className="sheet mt-5 overflow-x-auto px-5 py-4">
            <div className="mb-2 text-[13.5px] text-ink-soft">
              完成 {done.length}/{runs.length}　通过独立检查 {passedReview}　自动检查通过 {checkPass}/{checkTotal}
            </div>
            <table className="w-full border-collapse text-[13.5px]">
              <thead>
                <tr className="border-b border-rule-strong text-left text-ink-soft">
                  <th className="px-2 py-1.5 font-medium">用例</th>
                  <th className="px-2 py-1.5 font-medium">状态</th>
                  <th className="px-2 py-1.5 font-medium">用时</th>
                  <th className="px-2 py-1.5 font-medium">轮数</th>
                  <th className="px-2 py-1.5 font-medium">自动检查</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const c = EVAL_CASES.find((x) => x.id === r.caseId)!;
                  return (
                    <tr key={r.key} className="border-b border-rule align-top">
                      <td className="px-2 py-2">
                        <span className="num text-muted">{c.id}</span> {c.title}
                        {repeat > 1 && <span className="text-muted">（第 {r.attempt} 次）</span>}
                      </td>
                      <td className="px-2 py-2">
                        {r.status === 'running' ? (
                          <span className="flex items-center gap-1.5">
                            <Spinner /> {r.phase}
                          </span>
                        ) : r.status === 'done' ? (
                          r.outcome?.status === 'passed' ? (
                            <span className="text-teal">通过检查</span>
                          ) : r.outcome?.status === 'unresolved' ? (
                            <span className="text-seal">有未解决的问题</span>
                          ) : (
                            <span className="text-amber">检查未完成</span>
                          )
                        ) : r.status === 'error' ? (
                          <span className="text-seal" title={r.error}>
                            出错：{r.error?.slice(0, 40)}
                          </span>
                        ) : (
                          <span className="text-muted">排队中</span>
                        )}
                      </td>
                      <td className="num px-2 py-2">{r.ms ? formatDuration(r.ms) : ''}</td>
                      <td className="num px-2 py-2">{r.outcome ? r.outcome.rounds.length : ''}</td>
                      <td className="px-2 py-2">
                        {r.checks?.map((k) => (
                          <div key={k.label} className={k.pass ? 'text-teal' : 'text-seal'}>
                            {k.pass ? '✓' : '✗'} {k.label}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {faults.length > 0 && (
          <div className="sheet mt-5 px-5 py-4">
            <div className="mb-2 text-[15px] font-semibold">注入错误测试：检查环节能不能发现</div>
            <ul className="space-y-2 text-[13.5px]">
              {faults.map((f) => {
                const def = FAULTS.find((x) => x.id === f.id)!;
                return (
                  <li key={f.id} className="border-b border-rule pb-2">
                    <span className="num text-muted">{f.id}</span> 基于 {def.base}：{def.title}
                    {f.status === 'running' && <Spinner />}
                    {f.status === 'skipped' && <span className="text-muted">跳过（{def.base} 还没有运行结果）</span>}
                    {f.status === 'error' && <span className="text-seal">出错：{f.error}</span>}
                    {f.status === 'done' && (
                      <span className={f.detected ? 'text-teal' : 'text-seal'}>
                        {f.detected ? '已发现' : '未发现'}（{f.review?.issues.filter((i) => i.severity === '必须修改').length ?? 0} 个必须修改的问题，用时 {formatDuration(f.ms ?? 0)}）
                      </span>
                    )}
                    {f.review && (
                      <ul className="mt-1 pl-4 text-ink-soft">
                        {f.review.issues.map((i) => (
                          <li key={i.id}>
                            ［{i.severity}］{i.problem}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
