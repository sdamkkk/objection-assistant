// 过程记录：仿照思维链的样式，按"Agent 分析 / Agent 检查"分组，每一步用几个字概括在做什么，
// 下面是这一步的思考内容和调用的工具。

import { useState, type ReactNode } from 'react';
import type { ToolLogEntry } from '../core/types.ts';
import { summarizeTool, type TimelineEntry } from './timeline.ts';
import { formatDuration } from './ui.tsx';

type ModelEntry = Extract<TimelineEntry, { kind: 'model' }>;

/** 每个工具对应的"这一步在做什么" */
const STEP_VERB: Record<string, string> = {
  read_reference: '查阅业务资料',
  get_product: '查询产品信息',
  search_notices: '检索公告库',
  search_rules: '检索法规',
  read_document: '阅读原文',
  read_notice: '阅读原文',
  find_quote: '核对原文',
  calculate: '计算',
  trading_day: '推算交易日',
  compare: '比较',
  submit_result: '提交结果',
  submit_review: '提交检查结论',
};

const TOOL_NAME: Record<string, string> = {
  read_reference: '查阅资料',
  get_product: '产品信息',
  search_notices: '检索公告库',
  search_rules: '检索法规',
  read_document: '阅读',
  read_notice: '阅读',
  find_quote: '核对原文',
  calculate: '计算',
  trading_day: '交易日',
  compare: '比较',
  submit_result: '提交结果',
  submit_review: '提交检查结论',
};

// ---------------------------------------------------------------- 图标

function Icon({ name }: { name: string }) {
  const common = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'search_notices':
    case 'search_rules':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      );
    case 'read_document':
    case 'read_notice':
    case 'read_reference':
      return (
        <svg {...common}>
          <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
          <path d="M9.5 1.8V5h3M6 8h4.5M6 10.8h4.5" />
        </svg>
      );
    case 'find_quote':
      return (
        <svg {...common}>
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      );
    case 'calculate':
    case 'compare':
      return (
        <svg {...common}>
          <rect x="2.5" y="2" width="11" height="12" rx="2" />
          <path d="M5.5 5.5h5M5.5 9h1M9.5 9h1M5.5 11.5h1M9.5 11.5h1" />
        </svg>
      );
    case 'trading_day':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
      );
    case 'get_product':
      return (
        <svg {...common}>
          <path d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3z" />
          <path d="M2.5 5 8 8l5.5-3M8 8v6" />
        </svg>
      );
    case 'think':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.6" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.6" transform="rotate(60 8 8)" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.6" transform="rotate(120 8 8)" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <path d="M8 1.8 13 4v4c0 3-2.2 5.2-5 6.2C5.2 13.2 3 11 3 8V4z" />
          <path d="m5.8 8 1.6 1.6L10.4 6.4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      );
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- 分组

interface Step {
  key: number;
  model?: ModelEntry;
  tools: ToolLogEntry[];
  notes: { id: number; tone: 'warn' | 'error' | 'ok'; text: string }[];
}

interface Group {
  key: number;
  agent: 'ops' | 'review' | null;
  round: number;
  startAt: number;
  endAt: number;
  steps: Step[];
  review?: Extract<TimelineEntry, { kind: 'review' }>;
  submitted: boolean;
  failed: boolean;
}

function groupEntries(entries: TimelineEntry[]): Group[] {
  const groups: Group[] = [];
  let g: Group | null = null;
  const ensure = (e: TimelineEntry): Group => {
    if (!g) {
      g = { key: e.id, agent: null, round: 0, startAt: e.at, endAt: e.at, steps: [], submitted: false, failed: false };
      groups.push(g);
    }
    return g;
  };
  const lastStep = (grp: Group): Step => {
    let s = grp.steps.at(-1);
    if (!s) {
      s = { key: grp.key, tools: [], notes: [] };
      grp.steps.push(s);
    }
    return s;
  };
  for (const e of entries) {
    if (e.kind === 'phase') {
      g = { key: e.id, agent: e.agent, round: e.round, startAt: e.at, endAt: e.at, steps: [], submitted: false, failed: false };
      groups.push(g);
      continue;
    }
    const grp = ensure(e);
    grp.endAt = e.at;
    switch (e.kind) {
      case 'model':
        grp.steps.push({ key: e.id, model: e, tools: [], notes: [] });
        if (e.ms) grp.endAt = Math.max(grp.endAt, e.at + e.ms);
        break;
      case 'tool':
        lastStep(grp).tools.push(e.entry);
        break;
      case 'warn':
        lastStep(grp).notes.push({ id: e.id, tone: 'warn', text: e.text });
        break;
      case 'error':
        lastStep(grp).notes.push({ id: e.id, tone: 'error', text: e.text });
        grp.failed = true;
        break;
      case 'submitted':
        grp.submitted = true;
        break;
      case 'review':
        grp.review = e;
        grp.submitted = true;
        break;
    }
  }
  return groups;
}

function stepTitle(s: Step): string {
  const m = s.model;
  const names = s.tools.length ? s.tools.map((t) => t.name) : m?.toolCalls ?? [];
  const verbs = [...new Set(names.map((n) => STEP_VERB[n] ?? n))];
  if (verbs.length) return verbs.slice(0, 3).join('、') + (verbs.length > 3 ? '等' : '');
  if (m?.status === 'running') return m.toolArgsChars > 0 ? '准备调用工具' : m.reasoningChars > 0 ? '思考中' : '等待模型响应';
  if (s.notes.length) return '提示';
  return '整理思路';
}

// ---------------------------------------------------------------- 组件

function Thought({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const clean = text.trim();
  if (!clean) return null;
  // 正在生成时只显示最后一段，避免整块跳动
  const shown = live ? (clean.length > 260 ? `…${clean.slice(-260)}` : clean) : clean;
  const long = !live && clean.length > 180;
  return (
    <div className="mt-1">
      <p className={`whitespace-pre-wrap text-[13px] leading-relaxed text-muted ${long && !open ? 'line-clamp-3' : ''}`}>{shown}</p>
      {long && (
        <button type="button" className="mt-0.5 text-[12px] text-indigo/80 hover:text-indigo" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开思考'}
        </button>
      )}
    </div>
  );
}

const REF_NAME: Record<string, string> = {
  pitfalls: '易错点说明书',
  compliance: '合规口径',
  'output-formats': '产出格式',
  rules: '规则库导航',
};
const refName = (n: string) => REF_NAME[n] ?? (n.startsWith('types/') ? `类型指引：${n.slice(6)}` : n.startsWith('segments/') ? `客群指引：${n.slice(9)}` : n);

function ToolLine({ entry }: { entry: ToolLogEntry }) {
  const [open, setOpen] = useState(false);
  const raw = summarizeTool(entry);
  const s = entry.name === 'read_reference' ? { args: refName(String((entry.args as { name?: string })?.name ?? '')), result: '' } : raw;
  return (
    <li>
      <button type="button" className="group flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-indigo-soft/50" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`mt-[3px] shrink-0 ${entry.ok ? 'text-indigo/70' : 'text-seal'}`}>
          <Icon name={entry.name} />
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-relaxed">
          <span className="font-medium text-ink-soft">{TOOL_NAME[entry.name] ?? entry.name}</span>
          {s.args && <span className="ml-1.5 text-ink">{s.args}</span>}
          {s.result && <span className={`ml-1.5 ${entry.ok ? 'text-muted' : 'text-seal'}`}>· {s.result}</span>}
        </span>
        <span className="num mt-[3px] shrink-0 text-[11px] text-muted/70" title="工具调用编号，结果里的依据会引用它">
          {entry.ref}
        </span>
      </button>
      {open && (
        <pre className="mt-1 mb-1 ml-7 max-h-64 overflow-auto rounded-xl bg-paper px-3 py-2 text-[12px] leading-5 text-ink-soft">
          {JSON.stringify({ 参数: entry.args, 结果: entry.name === 'read_reference' ? { ...(entry.result as object), content: '（资料正文略）' } : entry.result }, null, 2)}
        </pre>
      )}
    </li>
  );
}

function StepBlock({ step, live }: { step: Step; live: boolean }) {
  const running = step.model?.status === 'running';
  return (
    <li className="relative pl-6">
      <span className={`absolute top-[7px] left-[3px] h-[9px] w-[9px] rounded-full ring-2 ring-white ${running ? 'pulse-dot bg-indigo' : 'bg-indigo/35'}`} aria-hidden="true" />
      <div className={`text-[13.5px] font-medium ${running ? 'text-indigo' : 'text-ink'}`}>{stepTitle(step)}</div>
      {step.model?.reasoning && <Thought text={step.model.reasoning} live={live && running} />}
      {step.tools.length > 0 && <ul className="mt-1 -ml-1.5">{step.tools.map((t) => <ToolLine key={t.ref} entry={t} />)}</ul>}
      {step.notes.map((n) => (
        <div key={n.id} className={`mt-1 text-[13px] ${n.tone === 'error' ? 'text-seal' : n.tone === 'warn' ? 'text-amber' : 'text-teal'}`}>
          {n.text}
        </div>
      ))}
    </li>
  );
}

function ReviewCard({ review }: { review: NonNullable<Group['review']> }) {
  const must = review.review.issues.filter((i) => i.severity === '必须修改');
  const sug = review.review.issues.length - must.length;
  return (
    <li className="relative pl-6">
      <span className={`absolute top-[7px] left-[3px] h-[9px] w-[9px] rounded-full ring-2 ring-white ${must.length ? 'bg-seal' : 'bg-teal'}`} aria-hidden="true" />
      <div className={`rounded-xl px-3 py-2 text-[13px] ${must.length ? 'bg-seal-soft' : 'bg-teal-soft'}`}>
        <div className={`font-medium ${must.length ? 'text-seal' : 'text-teal'}`}>
          {must.length ? `发现 ${must.length} 个必须修改的问题` : '没有必须修改的问题'}
          {sug ? `，${sug} 条建议` : ''}
          {review.willRework ? '，退回修改' : ''}
        </div>
        {review.review.summary && <div className="mt-0.5 text-ink-soft">{review.review.summary}</div>}
        {must.map((i) => (
          <div key={i.id} className="mt-0.5 text-ink-soft">
            · {i.problem}
          </div>
        ))}
      </div>
    </li>
  );
}

function groupTitle(g: Group, running: boolean): { text: string; icon: string } {
  if (!g.agent) return { text: '准备', icon: 'default' };
  const who = g.agent === 'ops' ? '应答 Agent' : '检查 Agent';
  const verb = g.agent === 'review' ? '核对' : g.round > 1 ? `修改（第 ${g.round} 轮）` : '生成话术';
  const icon = g.agent === 'ops' ? 'think' : 'review';
  if (running) return { text: `${who}：${verb}中`, icon };
  if (g.failed) return { text: `${who}：${verb}未完成`, icon };
  return { text: `${who}：${verb}完成`, icon };
}

function GroupBlock({ g, running, defaultOpen, now }: { g: Group; running: boolean; defaultOpen: boolean; now: number }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  const title = groupTitle(g, running);
  const ms = (running ? now : g.endAt) - g.startAt;
  let body: ReactNode = null;
  if (open) {
    body = (
      <ol className="relative mt-2 ml-[7px] space-y-3 border-l border-indigo/15 pb-1 pl-0">
        {g.steps.map((s, i) => (
          <StepBlock key={s.key} step={s} live={running && i === g.steps.length - 1} />
        ))}
        {g.review && <ReviewCard review={g.review} />}
      </ol>
    );
  }
  return (
    <section>
      <button type="button" className="flex w-full items-center gap-2 rounded-full py-1 pr-2 text-left" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        <span className={running ? 'pulse-dot text-indigo' : 'text-indigo/80'}>
          <Icon name={title.icon} />
        </span>
        <span className={`text-[14.5px] font-semibold ${running ? 'text-indigo' : 'text-ink'}`}>{title.text}</span>
        {g.agent && ms > 0 && <span className="num text-[12.5px] text-muted">{running ? `已用时 ${formatDuration(ms)}` : `用时 ${formatDuration(ms)}`}</span>}
        <span className="text-muted">
          <Chevron open={open} />
        </span>
      </button>
      {body}
    </section>
  );
}

export function Timeline({ entries, running = false }: { entries: TimelineEntry[]; running?: boolean }) {
  if (!entries.length) return <p className="text-[13.5px] text-muted">开始处理后，这里实时显示每一步。</p>;
  // 应答和检查两个 agent 的每一步都展示：读了哪些资料和规定、核对了什么、检查发现了什么问题、返工了几轮
  const groups = groupEntries(entries);
  const now = Date.now();
  return (
    <div className="space-y-4">
      {groups.map((g, i) => {
        const last = i === groups.length - 1;
        const isRunning = running && last;
        // 正在进行的和最后一组默认展开，前面已完成的默认收起
        return <GroupBlock key={g.key} g={g} running={isRunning} defaultOpen={last || !g.agent} now={now} />;
      })}
    </div>
  );
}
