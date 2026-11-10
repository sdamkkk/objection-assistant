// 页面框架：口令校验、左右两栏（案例 / 工作区）、最近处理记录、验证页入口。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collectCitations, type DocProvider } from '../core/citations.ts';
import { NoticeIndex } from '../core/textfind.ts';
import { EvalPage } from './EvalPage.tsx';
import { orderedSections } from './export.ts';
import { makeProvider, openLibraries } from './library.ts';
import { NoticePane, kbRequestsFor, type Highlight, type NoticeState } from './NoticePane.tsx';
import { OriginalViewer, type ViewerTarget } from './OriginalViewer.tsx';
import { ResultView } from './ResultView.tsx';
import { clearHistory, loadCode, loadHistory, saveCode, type HistoryEntry } from './storage.ts';
import { Timeline } from './Timeline.tsx';
import { Composer } from './Composer.tsx';
import { formatDuration } from './ui.tsx';
import { useRunner } from './useRunner.ts';

interface ServerConfig {
  requireCode: boolean;
  codeOk: boolean;
  hasKey: boolean;
  ops: { model: string; thinking: boolean; effort: string };
  review: { model: string; thinking: boolean; effort: string };
  /** 可选的模型（目前只有一个） */
  models?: string[];
}

const THINKING_KEY = 'ora.thinking';
function loadThinking(): boolean | null {
  try {
    const v = localStorage.getItem(THINKING_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}
function saveThinking(v: boolean) {
  try {
    localStorage.setItem(THINKING_KEY, v ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function useServerConfig(code: string) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/config', { headers: { 'x-access-code': code } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`接口返回 ${r.status}`);
        return (await r.json()) as ServerConfig;
      })
      .then((c) => alive && (setCfg(c), setErr('')))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [code]);
  return { cfg, err };
}

function AccessGate({ onSubmit, wrong }: { onSubmit: (c: string) => void; wrong: boolean }) {
  const [v, setV] = useState('');
  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <div className="sheet px-6 py-6">
        <h1 className="text-[18px] font-semibold">客户异议应答助手</h1>
        <p className="mt-1 text-[13.5px] text-ink-soft">这是演示环境，请输入体验口令。</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (v.trim()) onSubmit(v.trim());
          }}
        >
          <input className="field" type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="体验口令" aria-label="体验口令" />
          <button className="btn btn-primary shrink-0" type="submit">
            进入
          </button>
        </form>
        {wrong && <p className="mt-2 text-[13px] text-seal">口令不正确，请重新输入。</p>}
      </div>
    </div>
  );
}

function HistoryList({ items, onOpen, onClear }: { items: HistoryEntry[]; onOpen: (h: HistoryEntry) => void; onClear: () => void }) {
  if (!items.length) return <p className="px-1 text-[13.5px] text-muted">还没有处理记录。记录只保存在这台电脑的浏览器里。</p>;
  return (
    <div>
      <ul className="divide-y divide-rule">
        {items.map((h) => (
          <li key={h.id}>
            <button className="w-full px-1 py-2.5 text-left hover:bg-paper" onClick={() => onOpen(h)}>
              <div className="truncate text-[14px] font-medium">{h.noticeTitle}</div>
              <div className="truncate text-[13px] text-ink-soft">{h.requests[0]}</div>
              <div className="text-[12px] text-muted">
                {new Date(h.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {h.outcome ? (h.outcome.status === 'passed' ? '已完成' : '有待审核的内容') : '处理中断'}　用时 {formatDuration(h.durationMs)}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn-quiet mt-2 text-[13px]" onClick={onClear}>
        清空记录
      </button>
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const [code, setCode] = useState(loadCode);
  const { cfg, err } = useServerConfig(code);
  const getCode = useCallback(() => code, [code]);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  // 输入框里的"深度思考"开关和模型选择；开始处理时取一次
  const [thinkingPref, setThinkingPref] = useState<boolean | null>(loadThinking);
  const thinking = thinkingPref ?? cfg?.ops.thinking ?? true;
  const models = cfg?.models?.length ? cfg.models : [cfg?.ops.model ?? 'deepseek-flash'];
  const [modelPick, setModelPick] = useState<string | null>(null);
  const model = modelPick && models.includes(modelPick) ? modelPick : models[0];
  const runOptsRef = useRef({ thinking, model });
  runOptsRef.current = { thinking, model };
  const getRunOptions = useCallback(() => runOptsRef.current, []);
  const setThinking = (v: boolean) => {
    setThinkingPref(v);
    saveThinking(v);
  };
  const runner = useRunner(getCode, setHistory, getRunOptions);
  const { state } = runner;

  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [request, setRequest] = useState('');
  const [follow, setFollow] = useState('');
  const [view, setView] = useState<'result' | 'process'>('result');
  const [showHistory, setShowHistory] = useState(false);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [, tick] = useState(0);

  const running = state.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // 打开历史记录时，左栏换成当时的公告
  const shownText = state.readOnly ? state.noticeText : notice?.text ?? '';
  const index = useMemo(() => (shownText ? new NoticeIndex(shownText) : null), [shownText]);
  const onQuote = useCallback(
    (q: string) => {
      if (!index) return;
      const r = index.find(q);
      setHighlight(r.found ? { start: r.hits[0].start, end: r.hits[0].end, found: true, quote: q } : { start: 0, end: 0, found: false, quote: q });
    },
    [index],
  );

  const sampleRequests = kbRequestsFor(notice);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  // 引用定位：当前公告 + 本次用到的文件库（打开历史记录时重新加载）
  const [provider, setProvider] = useState<DocProvider | null>(null);
  useEffect(() => {
    const meta = state.notice;
    if (!meta) {
      setProvider(null);
      return;
    }
    if (state.libs) {
      setProvider(makeProvider(meta, state.libs, state.fileData));
      return;
    }
    let alive = true;
    void openLibraries(meta).then((l) => alive && setProvider(makeProvider(meta, l, state.fileData)));
    return () => {
      alive = false;
    };
  }, [state.notice, state.libs, state.fileData]);
  const latestResult = state.outcome?.result ?? state.rounds.at(-1)?.result;
  const cites = useMemo(() => (latestResult && provider ? collectCitations(latestResult, provider, orderedSections(latestResult)) : null), [latestResult, provider]);
  const onCite = useCallback(
    (n: number) => {
      const c = cites?.list[n - 1];
      if (!c) return;
      if (c.tag === '案例材料') {
        if (c.quote) onQuote(c.quote);
        return;
      }
      if (c.doc) setViewer({ doc: c.doc, citation: c });
    },
    [cites, onQuote],
  );
  const lastPhase = [...state.timeline].reverse().find((t) => t.kind === 'phase');
  const phase =
    running && lastPhase && lastPhase.kind === 'phase'
      ? `${lastPhase.agent === 'review' ? '检查 Agent 核对中' : lastPhase.round > 1 ? '应答 Agent 修改中' : '应答 Agent 生成中'} · 已用时 ${formatDuration(Date.now() - state.startedAt)}`
      : '';

  // ---- 回到首页（选择公告）：顶栏标题、"选择其他公告"按钮、浏览器后退键都走这里
  const atWork = Boolean(notice) || state.status !== 'idle' || Boolean(state.readOnly);
  const leaveWork = useCallback((): boolean => {
    if (running && !window.confirm('正在处理中，返回首页会停止本次处理。确定返回吗？')) return false;
    if (running) runner.stop();
    runner.reset();
    setNotice(null);
    setRequest('');
    setFollow('');
    setHighlight(null);
    setViewer(null);
    setShowHistory(false);
    setView('result');
    window.scrollTo({ top: 0 });
    return true;
  }, [running, runner]);
  const leaveRef = useRef(leaveWork);
  leaveRef.current = leaveWork;
  const atWorkRef = useRef(atWork);
  atWorkRef.current = atWork;

  // 进入工作台时压一条浏览记录，这样浏览器的后退键会回到首页，而不是离开网站
  useEffect(() => {
    if (atWork && !(window.history.state as { work?: boolean } | null)?.work) window.history.pushState({ work: true }, '');
  }, [atWork]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if ((e.state as { work?: boolean } | null)?.work || !atWorkRef.current) return;
      if (!leaveRef.current()) window.history.pushState({ work: true }, '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const goHome = useCallback(() => {
    if (!atWorkRef.current) return;
    // 有工作台的浏览记录时，用后退回到首页，让浏览器的前进/后退保持一致
    if ((window.history.state as { work?: boolean } | null)?.work) window.history.back();
    else leaveRef.current();
  }, []);

  if (route === '#/eval') return <EvalPage getCode={getCode} />;
  if (cfg?.requireCode && !cfg.codeOk) {
    return (
      <AccessGate
        wrong={Boolean(code)}
        onSubmit={(c) => {
          saveCode(c);
          setCode(c);
        }}
      />
    );
  }

  const canStart = Boolean(notice) && request.trim().length > 0 && !running;
  const start = () => {
    if (!notice || !canStart) return;
    setHighlight(null);
    setView('process');
    void runner.start(notice, request.trim());
  };

  const leftNotice: NoticeState | null = state.readOnly ? { ...(state.notice ?? { title: state.noticeTitle, text: state.noticeText }), origin: `历史记录 · ${state.notice?.origin ?? ''}` } : notice;

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/80 bg-white/45 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 lg:px-6">
          <h1>
            <button type="button" onClick={goHome} title="回到首页" className="flex items-center gap-2 rounded-full pr-2 text-[18px] font-semibold tracking-tight text-ink hover:text-indigo">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-indigo text-white shadow-[0_6px_14px_-6px_rgba(77,107,254,0.9)]">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="6.8" cy="6.8" r="4.3" />
                <path d="M10 10l3.6 3.6" />
              </svg>
            </span>
            客户异议应答助手
            </button>
          </h1>
          <span className="flex-1" />
          {err && <span className="text-[12.5px] text-seal" title={err}>接口连接失败</span>}
          {cfg && !cfg.hasKey && <span className="text-[12.5px] text-seal">服务端未配置模型密钥</span>}
          <button className="btn btn-quiet text-[13px]" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            历史 {history.length}
          </button>
        </div>
        {showHistory && (
          <div className="mx-auto max-w-[1500px] px-4 pb-3 lg:px-6">
            <div className="sheet max-h-80 overflow-auto px-3 py-2">
              <HistoryList
                items={history}
                onOpen={(h) => {
                  runner.open(h);
                  setShowHistory(false);
                  setView('result');
                  setHighlight(null);
                }}
                onClear={() => {
                  clearHistory();
                  setHistory([]);
                }}
              />
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-6 px-4 py-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:px-6">
        <div className="min-w-0 lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100vh-6rem)] lg:flex-col">
          <NoticePane
            notice={leftNotice}
            onChange={(n) => {
              if (n === null) return goHome();
              if (state.readOnly) runner.reset();
              setNotice(n);
              setHighlight(null);
            }}
            highlight={highlight}
            locked={running}
          />
        </div>

        {/* 还没开始处理时，需求输入框在右栏上下居中（略偏上）；开始处理后回到顶部，下面接结果 */}
        <div className={`min-w-0 ${state.status === 'idle' && !state.readOnly ? 'lg:flex lg:min-h-[calc(100vh-6.5rem)] lg:flex-col lg:justify-center lg:pb-[8vh]' : ''}`}>
          {state.readOnly ? (
            <div className="sheet mb-4 flex items-center justify-between gap-3 px-5 py-3 text-[13.5px]">
              <div className="min-w-0">
                <div className="text-ink-soft">历史记录（只能查看）</div>
                {state.requests.map((r, i) => (
                  <div key={i} className="truncate">
                    {i > 0 ? `追问 ${i}：` : ''}
                    {r}
                  </div>
                ))}
              </div>
              <button className="btn shrink-0" onClick={() => runner.reset()}>
                返回工作台
              </button>
            </div>
          ) : (
            <div>
              <label htmlFor="req" className="mb-2 block px-1 text-[15px] font-semibold">
                应答要求
              </label>
              <Composer
                id="req"
                value={state.status === 'idle' ? request : state.requests[0] ?? request}
                onChange={setRequest}
                locked={state.status !== 'idle'}
                placeholder="要给哪类客户写话术，有什么特别的要求"
                canSubmit={canStart}
                onSubmit={start}
                running={running}
                onStop={runner.stop}
                submitLabel="生成话术"
                thinking={thinking}
                onThinking={setThinking}
                model={model}
                models={models}
                onModel={setModelPick}
                hint={!notice ? '先在左侧填写案例' : running ? phase : ''}
                action={
                  state.status !== 'idle' && !running ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        runner.reset();
                        setHighlight(null);
                      }}
                    >
                      换一个要求
                    </button>
                  ) : undefined
                }
              />
              {state.status === 'idle' && sampleRequests.length > 0 && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 px-1 text-[13px]">
                  <span className="text-muted">示例：</span>
                  {sampleRequests.map((r) => (
                    <button key={r.label} className="rounded-full border border-rule bg-sheet/80 px-3 py-0.5 text-ink-soft hover:border-indigo hover:text-indigo" onClick={() => setRequest(r.text)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.status !== 'idle' && (
            <div className="mt-5">
              <div className="mb-3 inline-flex rounded-full border border-rule bg-sheet/80 p-1 text-[13.5px] backdrop-blur" role="tablist">
                {(
                  [
                    ['result', '结果'],
                    ['process', `过程 · ${state.toolLog.length} 次工具调用`],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={view === k} className={`rounded-full px-4 py-1 transition-colors ${view === k ? 'bg-indigo-soft font-medium text-indigo' : 'text-ink-soft hover:text-ink'}`} onClick={() => setView(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="sheet px-5 py-4 lg:px-6">
                {view === 'result' ? <ResultView state={state} index={index} onQuote={onQuote} phase={phase} cites={cites} onCite={onCite} run={{ model, thinking }} /> : <Timeline entries={state.timeline} running={running} />}
              </div>

              {!state.readOnly && state.status !== 'running' && runner.hasSession() && state.rounds.length > 0 && (
                <div className="mt-4">
                  <label htmlFor="follow" className="mb-2 block px-1 text-[15px] font-semibold">
                    追问
                  </label>
                  <Composer
                    id="follow"
                    value={follow}
                    onChange={setFollow}
                    placeholder="补充客户的情况，或者提出修改要求"
                    canSubmit={Boolean(follow.trim())}
                    onSubmit={() => {
                      runner.followUp(follow.trim());
                      setFollow('');
                      setView('process');
                    }}
                    submitLabel="提交追问"
                    thinking={thinking}
                    onThinking={setThinking}
                    model={model}
                    models={models}
                    onModel={setModelPick}
                    minHeight={72}
                  />
                </div>
              )}
              {state.requests.length > 1 && !state.readOnly && (
                <div className="mt-3 text-[13px] text-ink-soft">
                  {state.requests.slice(1).map((r, i) => (
                    <div key={i}>
                      追问 {i + 1}：{r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {viewer && <OriginalViewer key={`${viewer.doc.id}:${viewer.citation?.n ?? 0}`} target={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
