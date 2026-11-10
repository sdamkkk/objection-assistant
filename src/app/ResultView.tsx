// 结果区：复核结论、系统对需求的理解、按读者分块的产出（每条带依据）、导出。

import { Fragment, useMemo, useState } from 'react';
import { citationLabel, isOriginal, type Citation, type CitationSet } from '../core/citations.ts';
import type { NoticeIndex } from '../core/textfind.ts';
import type { Item, ReviewIssue, Section, Source, ToolLogEntry } from '../core/types.ts';
import { AUDIENCE_LABEL, downloadBlob, orderedSections, safeFilename, sectionToMarkdown, toDocx, toMarkdown, toRunRecord } from './export.ts';
import { ResultToc, ResultTocInline, type TocEntry } from './ResultToc.tsx';
import { TOOL_LABELS, summarizeTool } from './timeline.ts';
import type { RunState } from './useRunner.ts';
import { Spinner, TAG_STYLE, copyText, formatDuration } from './ui.tsx';

// ---------------------------------------------------------------- 来源

function refsOf(s: Source): string[] {
  return (s.ref ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
}

function SourceChips(props: {
  item: Item;
  index: NoticeIndex | null;
  onQuote: (q: string) => void;
  open: number | null;
  setOpen: (i: number | null) => void;
}) {
  const { item, index, onQuote, open, setOpen } = props;
  if (!item.sources.some((s) => !isOriginal(s))) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {item.sources.map((s, i) => {
        if (isOriginal(s)) return null;
        const missing = s.tag === '案例材料' && s.quote && index ? !index.find(s.quote).found : false;
        const label = s.tag === '工具计算' && s.ref ? `${s.tag} ${refsOf(s).join(' ')}` : s.tag === '业务规则' && s.note && /^P\d+/.test(s.note) ? `${s.tag} ${s.note}` : s.tag;
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              if (s.tag === '案例材料' && s.quote) onQuote(s.quote);
              setOpen(open === i ? null : i);
            }}
            className={`rounded-full px-2 text-[12px] leading-5 transition-opacity hover:opacity-80 ${missing ? 'bg-seal-soft text-seal ring-1 ring-inset ring-seal/40' : TAG_STYLE[s.tag] ?? 'bg-slate-soft'}`}
            aria-expanded={open === i}
            title={missing ? '这段引用在原文中找不到' : '查看依据'}
          >
            {missing ? `${label}（原文中未找到）` : label}
          </button>
        );
      })}
    </div>
  );
}

/** 原文引用的角标：[1][2]，点开查看原件。找不到原文或越过时间边界的标红。 */
function CiteMarks({ id, ctx }: { id: string; ctx: ItemCtx }) {
  const nums = ctx.cites?.byItem[id];
  if (!nums?.length) return null;
  return (
    <span className="ml-0.5 whitespace-nowrap align-super text-[11px] leading-none">
      {nums.map((n) => {
        const c = ctx.cites!.list[n - 1];
        const bad = !c.found || Boolean(c.problem);
        return (
          <button
            key={n}
            type="button"
            className={`mx-[1px] rounded px-[3px] py-px font-medium ${bad ? 'bg-seal-soft text-seal' : 'bg-indigo-soft text-indigo hover:bg-indigo hover:text-white'}`}
            title={`${citationLabel(c)}${bad ? `（${c.problem}）` : ''}`}
            onClick={() => ctx.onCite(n)}
          >
            {n}
          </button>
        );
      })}
    </span>
  );
}

function SourceDetail({ source, log }: { source: Source; log: ToolLogEntry[] }) {
  if (source.tag === '工具计算') {
    const refs = refsOf(source);
    const entries = log.filter((e) => refs.includes(e.ref));
    return (
      <div className="mt-1.5 rounded-2xl border border-teal/25 bg-teal-soft/50 px-3 py-2 text-[13px]">
        {entries.length === 0 && <div className="text-seal">找不到编号为 {source.ref} 的工具调用记录。</div>}
        {entries.map((e) => {
          const s = summarizeTool(e);
          return (
            <div key={e.ref} className="num">
              <span className="text-teal">{e.ref} {TOOL_LABELS[e.name] ?? e.name}</span>　{s.args}　<span className="font-medium">{s.result}</span>
            </div>
          );
        })}
        {source.note && <div className="mt-1 text-ink-soft">{source.note}</div>}
      </div>
    );
  }
  const body = source.quote ? `“${source.quote}”` : source.note ?? '';
  if (!body) return null;
  return <div className="mt-1.5 rounded-2xl border border-rule bg-paper px-3 py-2 text-[13px] text-ink-soft">{body}{source.quote && source.note ? `　${source.note}` : ''}</div>;
}

// ---------------------------------------------------------------- 条目

function IssueNote({ issue, tone }: { issue: ReviewIssue; tone: 'must' | 'suggest' }) {
  return (
    <div className={`mt-1.5 rounded-xl px-3 py-1.5 text-[13px] ${tone === 'must' ? 'bg-seal-soft text-seal' : 'bg-amber-soft text-amber'}`}>
      {tone === 'must' ? '请重点审核：' : ''}
      {issue.problem}
      {issue.suggestion ? `（${issue.suggestion}）` : ''}
    </div>
  );
}

function ItemBlock(props: {
  section: Section;
  item: Item;
  n: number;
  ctx: ItemCtx;
}) {
  const { section, item, n, ctx } = props;
  const [open, setOpen] = useState<number | null>(null);
  const must = ctx.unresolved.filter((i) => i.item_id === item.id);
  const sug = ctx.suggestions.filter((i) => i.item_id === item.id);
  const head = null;
  let body;
  if (section.kind === 'qa') {
    body = (
      <>
        <div className="font-medium">
          问：{item.question}
          {head}
        </div>
        <div className="mt-0.5">
          答：{item.answer}
          <CiteMarks id={item.id} ctx={ctx} />
        </div>
        {item.forbidden?.length ? (
          <div className="mt-1.5 text-[13.5px]">
            <span className="text-seal">禁止说法：</span>
            {item.forbidden.map((f, i) => (
              <span key={i} className="mr-1.5 inline-block rounded bg-seal-soft px-1.5 text-seal line-through decoration-seal/40">
                {f}
              </span>
            ))}
          </div>
        ) : null}
        {item.escalate && (
          <div className="mt-1 text-[13.5px] text-ink-soft">
            <span className="text-ink">升级条件：</span>
            {item.escalate}
          </div>
        )}
      </>
    );
  } else if (section.kind === 'steps') {
    body = (
      <div className="flex gap-2">
        <span className="num w-5 shrink-0 text-right text-muted">{n}.</span>
        <span>
          {item.text}
          <CiteMarks id={item.id} ctx={ctx} />
          {head}
        </span>
      </div>
    );
  } else {
    body = (
      <div>
        {item.text}
        <CiteMarks id={item.id} ctx={ctx} />
        {head}
      </div>
    );
  }
  return (
    <li className={`py-2.5 ${must.length ? 'border-l-2 border-seal pl-3' : ''}`}>
      {body}
      <div className={section.kind === 'steps' ? 'pl-7' : ''}>
        <SourceChips item={item} index={ctx.index} onQuote={ctx.onQuote} open={open} setOpen={setOpen} />
        {open !== null && item.sources[open] && <SourceDetail source={item.sources[open]} log={ctx.log} />}
        {must.map((i) => (
          <IssueNote key={i.id} issue={i} tone="must" />
        ))}
        {sug.map((i) => (
          <IssueNote key={i.id} issue={i} tone="suggest" />
        ))}
      </div>
    </li>
  );
}

interface ItemCtx {
  index: NoticeIndex | null;
  onQuote: (q: string) => void;
  cites: CitationSet | null;
  onCite: (n: number) => void;
  log: ToolLogEntry[];
  unresolved: ReviewIssue[];
  suggestions: ReviewIssue[];
}

function TableBlock({ section, ctx }: { section: Section; ctx: ItemCtx }) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = section.columns ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="border-b border-rule-strong text-left text-ink-soft">
            {cols.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">
                {c}
              </th>
            ))}
            <th className="px-2 py-1.5 font-medium">依据</th>
          </tr>
        </thead>
        <tbody>
          {section.items.map((it) => {
            const unchanged = (it.cells?.[2] ?? '').startsWith('不变');
            const must = ctx.unresolved.filter((i) => i.item_id === it.id);
            return (
              <Fragment key={it.id}>
                <tr className={`border-b border-rule align-top ${unchanged ? 'text-muted' : ''} ${must.length ? 'bg-seal-soft/60' : ''}`}>
                  {(it.cells ?? []).map((c, i) => (
                    <td key={i} className={`px-2 py-2 ${i === 2 && !unchanged ? 'font-medium text-ink' : ''}`}>
                      {c}
                    </td>
                  ))}
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <CiteMarks id={it.id} ctx={ctx} />
                      {it.sources.map((s, k) => isOriginal(s) ? null : (
                        <button
                          key={k}
                          type="button"
                          className={`rounded-full px-2 text-[12px] leading-5 ${TAG_STYLE[s.tag] ?? ''}`}
                          onClick={() => {
                            if (s.tag === '案例材料' && s.quote) ctx.onQuote(s.quote);
                            setOpen(open === `${it.id}:${k}` ? null : `${it.id}:${k}`);
                          }}
                        >
                          {s.tag === '工具计算' && s.ref ? `${s.tag} ${s.ref}` : s.tag}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
                {open?.startsWith(`${it.id}:`) && (
                  <tr>
                    <td colSpan={cols.length + 1} className="px-2 pb-2">
                      <SourceDetail source={it.sources[Number(open.split(':')[1])]} log={ctx.log} />
                    </td>
                  </tr>
                )}
                {must.map((i) => (
                  <tr key={i.id}>
                    <td colSpan={cols.length + 1} className="px-2 pb-2">
                      <IssueNote issue={i} tone="must" />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionBlock({ section, ctx, no }: { section: Section; ctx: ItemCtx; no: number }) {
  const [copied, setCopied] = useState(false);
  const isDraft = section.kind === 'draft';
  const copy = async () => {
    if (await copyText(sectionToMarkdown(section))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const sectionIssues = ctx.unresolved.filter((i) => i.section_id === section.id && !i.item_id);
  return (
    <section id={sectionAnchor(section.id)} className="scroll-mt-4 border-t border-rule py-6 first:border-t-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="flex items-baseline gap-2.5 text-[17px] font-semibold">
          <span className="num text-[14px] font-semibold text-indigo">{String(no).padStart(2, '0')}</span>
          <span>{section.title}</span>
          {(AUDIENCE_LABEL[section.audience] ?? section.audience) !== section.title && (
            <span className="rounded bg-slate-soft px-1.5 text-[12px] font-normal leading-5 text-slate-tag">{AUDIENCE_LABEL[section.audience] ?? section.audience}</span>
          )}
        </h3>
        <button className="btn btn-quiet text-[13px]" onClick={copy} title="复制时不带依据标注">
          {copied ? '已复制' : isDraft ? '复制话术' : '复制'}
        </button>
      </div>
      {sectionIssues.map((i) => (
        <IssueNote key={i.id} issue={i} tone="must" />
      ))}
      {section.kind === 'table' ? (
        <TableBlock section={section} ctx={ctx} />
      ) : isDraft ? (
        section.items.map((it) => (
          <div key={it.id} className="mt-2">
            <div className="doc whitespace-pre-wrap rounded-2xl border border-rule bg-paper/60 px-5 py-4 text-[15px]">
              {it.text}
              <CiteMarks id={it.id} ctx={ctx} />
            </div>
            <ul>
              <ItemBlockSources item={it} ctx={ctx} />
            </ul>
          </div>
        ))
      ) : (
        <ul className={section.kind === 'qa' ? 'divide-y divide-rule' : ''}>
          {section.items.map((it, i) => (
            <ItemBlock key={it.id} section={section} item={it} n={i + 1} ctx={ctx} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemBlockSources({ item, ctx }: { item: Item; ctx: ItemCtx }) {
  const [open, setOpen] = useState<number | null>(null);
  const must = ctx.unresolved.filter((i) => i.item_id === item.id);
  const sug = ctx.suggestions.filter((i) => i.item_id === item.id);
  return (
    <li>
      <SourceChips item={item} index={ctx.index} onQuote={ctx.onQuote} open={open} setOpen={setOpen} />
      {open !== null && item.sources[open] && <SourceDetail source={item.sources[open]} log={ctx.log} />}
      {must.map((i) => (
        <IssueNote key={i.id} issue={i} tone="must" />
      ))}
      {sug.map((i) => (
        <IssueNote key={i.id} issue={i} tone="suggest" />
      ))}
    </li>
  );
}

// ---------------------------------------------------------------- 理解与复核

/** 只在需要运营注意时显示一行状态：处理中、检查未通过、检查没完成、出错。通过了不占位置。 */
function StatusNote({ state, phase }: { state: RunState; phase: string }) {
  const o = state.outcome;
  if (state.status === 'running') {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-full bg-indigo-soft/70 px-4 py-2 text-[13.5px] text-indigo">
        <Spinner />
        {phase || 'Agent分析中'}
      </div>
    );
  }
  if (o?.status === 'unresolved') {
    return <div className="mb-4 rounded-2xl bg-seal-soft px-4 py-2.5 text-[13.5px] text-seal">有 {o.unresolved.length} 处内容需要重点审核，已标红。</div>;
  }
  if (o?.status === 'review_failed') {
    return <div className="mb-4 rounded-2xl bg-amber-soft px-4 py-2.5 text-[13.5px] text-amber">合规检查没有完成，使用前请人工核对数字、引用和表述。</div>;
  }
  if (state.status === 'error') {
    return <div className="mb-4 rounded-2xl bg-seal-soft px-4 py-2.5 text-[13.5px] text-seal">处理中断：{state.error}</div>;
  }
  return null;
}

// ---------------------------------------------------------------- 引用原文

const LIB_LABEL: Record<string, string> = { notice: '案例材料', fund: '产品文件', rules: '法规原文' };

function CitationList({ list, onCite, no }: { list: Citation[]; onCite: (n: number) => void; no: number }) {
  const bad = list.filter((c) => !c.found || c.problem).length;
  return (
    <section id={CITES_ANCHOR} className="scroll-mt-4 border-t border-rule py-6">
      <h3 className="text-[17px] font-semibold">
        <span className="num mr-2.5 text-[14px] text-indigo">{String(no).padStart(2, '0')}</span>
        引用原文
        <span className="ml-2 align-middle text-[12.5px] font-normal text-muted" title="文字由系统在原件中定位后逐字取出，不是模型写的引文">
          共 {list.length} 处{bad ? `，其中 ${bad} 处有问题` : '，均已在原件中找到'}
        </span>
      </h3>
      <ol className="space-y-2.5">
        {list.map((c) => {
          const problem = !c.found || c.problem;
          return (
            <li key={c.n} id={`cite-${c.n}`} className={`rounded-2xl border px-3 py-2 text-[13.5px] ${problem ? 'border-seal/30 bg-seal-soft/40' : 'border-rule bg-paper/50'}`}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`num font-semibold ${problem ? 'text-seal' : 'text-indigo'}`}>[{c.n}]</span>
                {c.doc?.library !== 'notice' && <span className="text-[12px] text-muted">{LIB_LABEL[c.doc?.library ?? ''] ?? c.tag}</span>}
                <span className="min-w-0 flex-1">{citationLabel(c)}</span>
                {c.doc && (
                  <button className="text-[12.5px] text-indigo hover:underline" onClick={() => onCite(c.n)}>
                    查看原件
                  </button>
                )}
              </div>
              {c.found && c.segments ? (
                <blockquote className="doc mt-1 border-l-2 border-indigo/40 pl-2.5 text-ink">
                  {c.segments.map((s, i) => (
                    <span key={i}>
                      {i > 0 && <span className="mx-1 align-middle text-[11px] text-muted">（转{s.location}）</span>}
                      {s.text}
                    </span>
                  ))}
                </blockquote>
              ) : c.found ? (
                <blockquote className="doc mt-1 border-l-2 border-indigo/40 pl-2.5 text-ink">{c.excerpt}</blockquote>
              ) : (
                <div className="mt-1 text-seal">
                  模型给出的引文：“{c.quote}”
                  {c.closest ? <div className="text-ink-soft">原文中最接近的一段：“{c.closest}”</div> : null}
                </div>
              )}
              {c.problem && <div className="mt-1 text-[12.5px] text-seal">{c.problem}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- 结果区

const OVERVIEW_ANCHOR = 'res-overview';
const CITES_ANCHOR = 'res-cites';
const sectionAnchor = (id: string) => `res-sec-${id.replace(/[^\w-]/g, '_')}`;

export function ResultView(props: {
  state: RunState;
  index: NoticeIndex | null;
  onQuote: (q: string) => void;
  phase: string;
  cites: CitationSet | null;
  onCite: (n: number) => void;
  /** 本次运行用的模型和深度思考设置，写进运行记录 */
  run?: { model?: string; thinking?: boolean };
}) {
  const { state, index, onQuote, phase, cites, onCite } = props;
  const [busy, setBusy] = useState('');
  const latest = state.outcome?.result ?? state.rounds.at(-1)?.result;

  const ctx: ItemCtx = useMemo(
    () => ({
      index,
      onQuote,
      cites,
      onCite,
      log: state.toolLog,
      unresolved: state.outcome?.unresolved ?? [],
      // 不向运营展示自动核对时提出的一般性建议
      suggestions: [],
    }),
    [index, onQuote, cites, onCite, state.toolLog, state.outcome],
  );

  if (!latest) {
    return (
      <div>
        <StatusNote state={state} phase={phase} />
        {state.status === 'running' && <p className="text-[13.5px] text-muted">报告生成后显示在这里，可以切换到"过程"查看每一步。</p>}
      </div>
    );
  }

  const outcome = state.outcome;
  const title = safeFilename(`${latest.objection.title}应答话术`);
  const done = state.status === 'done' && outcome;

  const sections = orderedSections(latest);
  const hasCites = Boolean(cites && cites.list.length > 0);
  const toc: TocEntry[] = [
    ...sections.map((s, i) => {
      const must = ctx.unresolved.filter((x) => x.section_id === s.id || s.items.some((it) => it.id === x.item_id)).length;
      const suggest = ctx.suggestions.filter((x) => x.section_id === s.id || s.items.some((it) => it.id === x.item_id)).length;
      const count = s.kind === 'draft' ? '' : s.kind === 'qa' ? `${s.items.length} 问` : `${s.items.length} 条`;
      const audience = AUDIENCE_LABEL[s.audience] ?? s.audience;
      const sub = [audience === s.title ? '' : audience, count].filter(Boolean).join(' · ');
      void suggest;
      return { id: sectionAnchor(s.id), no: i + 1, title: s.title, sub: sub || undefined, must };
    }),
    ...(hasCites
      ? [{ id: CITES_ANCHOR, no: sections.length + 1, title: '引用原文', sub: `${cites!.list.length} 处`, must: cites!.list.filter((c) => !c.found || c.problem).length }]
      : []),
  ];

  return (
    <div>
      <div id={OVERVIEW_ANCHOR} className="scroll-mt-4">
        <StatusNote state={state} phase={phase} />
        <ResultTocInline entries={toc} title={latest.objection.title} />
      </div>
      <div className="mt-2">
        {sections.map((s, i) => (
          <SectionBlock key={s.id} section={s} ctx={ctx} no={i + 1} />
        ))}
      </div>
      {hasCites && <CitationList list={cites!.list} onCite={onCite} no={sections.length + 1} />}
      <ResultToc entries={toc} />
      {done && (
        <div className="sticky bottom-0 -mx-1 mt-2 flex flex-wrap items-center gap-2 border-t border-rule bg-sheet/95 px-1 py-3 backdrop-blur">
          <button
            className="btn"
            onClick={async () => {
              if (await copyText(toMarkdown(outcome, { cites }))) {
                setBusy('已复制');
                setTimeout(() => setBusy(''), 1500);
              }
            }}
          >
            {busy === '已复制' ? '已复制' : '复制全部（Markdown）'}
          </button>
          <button className="btn" onClick={() => downloadBlob(new Blob([toMarkdown(outcome, { cites })], { type: 'text/markdown;charset=utf-8' }), `${title}.md`)}>
            下载 Markdown
          </button>
          <button
            className="btn"
            disabled={busy === 'docx'}
            onClick={async () => {
              setBusy('docx');
              try {
                downloadBlob(await toDocx(outcome, cites), `${title}.docx`);
              } finally {
                setBusy('');
              }
            }}
          >
            {busy === 'docx' ? '正在生成…' : '下载 Word'}
          </button>
          <button className="btn" title="输入、两个 agent 的每一步、检查发现的问题和每一轮的产出" onClick={() => downloadBlob(new Blob([toRunRecord(state, props.run)], { type: 'text/markdown;charset=utf-8' }), `${title}运行记录.md`)}>
            下载运行记录
          </button>
        </div>
      )}
      {state.finishedAt && (
        <p className="mt-2 text-[12px] text-muted">
          用时 {formatDuration(state.finishedAt - state.startedAt)} · 工具调用 {state.toolLog.length} 次
        </p>
      )}
    </div>
  );
}
