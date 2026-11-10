// 导出：Markdown（复制或下载）和 Word。

import { citationLabel, isOriginal, type Citation, type CitationSet } from '../core/citations.ts';
import type { SessionOutcome } from '../core/engine.ts';
import type { Item, OpsResult, Section, Source } from '../core/types.ts';
import { TOOL_LABELS, summarizeTool } from './timeline.ts';
import type { RunState } from './useRunner.ts';

export const AUDIENCE_ORDER = ['通用', '客户经理', '高净值客户（话术）', '普通理财客户（话术）'];
export const AUDIENCE_LABEL: Record<string, string> = {
  通用: '通用',
  客户经理: '给客户经理',
  '高净值客户（话术）': '对客话术',
  '普通理财客户（话术）': '对客话术',
};

/** 保持模型给出的顺序（产出格式里已规定各部分的先后），只把未知读者的部分放到最后。 */
export function orderedSections(r: OpsResult): Section[] {
  const known = r.sections.filter((s) => AUDIENCE_ORDER.includes(s.audience));
  const unknown = r.sections.filter((s) => !AUDIENCE_ORDER.includes(s.audience));
  return [...known, ...unknown];
}

export function sourceText(s: Source): string {
  const extra = s.quote ? `“${s.quote}”` : s.ref ? s.ref : s.note ?? '';
  return extra ? `${s.tag}：${extra}` : s.tag;
}

/** 依据一栏：原文引用由角标表示，这里只列其他来源 */
function otherSources(it: Item): string {
  return it.sources.filter((s) => !isOriginal(s)).map(sourceText).join('；');
}

function marks(it: Item, cites: CitationSet | null | undefined, style: 'md' | 'text'): string {
  const nums = cites?.byItem[it.id] ?? [];
  return nums.map((n) => (style === 'md' ? `[^${n}]` : `［${n}］`)).join('');
}

function absolute(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:/.test(url)) return url;
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

/** 一条引用的完整说明：出处、原件中的文字、原件地址 */
export function citationNote(c: Citation): string {
  const text = c.found ? `“${(c.excerpt ?? '').replace(/\s*\n\s*/g, ' ')}”` : `模型给出的引文“${c.quote}”在原件中没有找到`;
  const warn = c.found && c.problem ? `（注意：${c.problem}）` : '';
  const url = absolute(c.doc?.sourceUrl) ?? absolute(c.doc?.fileUrl);
  return `${citationLabel(c)}：${text}${warn}${url ? `　原件：${url}` : ''}`;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function itemMd(sec: Section, it: Item, n: number, withSources: boolean, cites?: CitationSet | null): string[] {
  const other = withSources ? otherSources(it) : '';
  const src = other ? `\n  <sub>依据：${other}</sub>` : '';
  const m = withSources ? marks(it, cites, 'md') : '';
  switch (sec.kind) {
    case 'qa': {
      const lines = [`**问：${it.question}**`, '', `答：${it.answer}${m}`];
      if (it.forbidden?.length) lines.push('', `禁止说法：${it.forbidden.map((f) => `“${f}”`).join('、')}`);
      if (it.escalate) lines.push('', `升级条件：${it.escalate}`);
      if (other) lines.push('', `<sub>依据：${other}</sub>`);
      lines.push('');
      return lines;
    }
    case 'steps':
      return [`${n}. ${it.text}${m}${src}`];
    case 'draft':
      return [...(it.text ?? '').split('\n').map((l) => `> ${l}`), ...(m ? ['>', `> ${m}`] : []), ''];
    case 'table':
      return [];
    default:
      return [`- ${it.text}${m}${src}`];
  }
}

export function toMarkdown(outcome: SessionOutcome | { result: OpsResult }, opts: { withSources?: boolean; title?: string; cites?: CitationSet | null } = {}): string {
  const r = outcome.result;
  const withSources = opts.withSources ?? true;
  const out: string[] = [];
  out.push(`# ${opts.title ?? r.objection.title}`, '', `异议类型：${r.objection.type}`, '', r.objection.summary, '');
  for (const sec of orderedSections(r)) {
    out.push(`## ${sec.title}（${AUDIENCE_LABEL[sec.audience] ?? sec.audience}）`, '');
    if (sec.kind === 'table') {
      const cols = sec.columns ?? [];
      out.push(`| ${cols.map(mdEscape).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
      for (const it of sec.items) {
        const cells = [...(it.cells ?? [])];
        if (withSources && cells.length) cells[cells.length - 1] += marks(it, opts.cites, 'md');
        out.push(`| ${cells.map(mdEscape).join(' | ')} |`);
      }
      out.push('');
    } else {
      sec.items.forEach((it, i) => out.push(...itemMd(sec, it, i + 1, withSources, opts.cites)));
      out.push('');
    }
  }
  if (withSources && opts.cites?.list.length) {
    out.push('## 引用原文', '', '以下文字由系统在案例材料和规则原文中定位后逐字取出。', '');
    for (const c of opts.cites.list) out.push(`[^${c.n}]: ${citationNote(c)}`);
    out.push('');
  }
  if ('status' in outcome) {
    out.push('---', '');
    if (outcome.unresolved.length) {
      out.push('需要重点审核：');
      for (const i of outcome.unresolved) out.push(`- ${i.problem}`);
      out.push('');
    }
    out.push('本材料由系统生成，需经客户经理审核后使用。');
  }
  return out.join('\n');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '').slice(0, 60) || '应答话术';
}

export async function toDocx(outcome: SessionOutcome, cites?: CitationSet | null): Promise<Blob> {
  const d = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = d;
  const r = outcome.result;
  const font = { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei' };
  const p = (text: string, o: { bold?: boolean; size?: number; color?: string } = {}) =>
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, bold: o.bold, size: o.size ?? 21, color: o.color, font })] });
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: r.objection.title, font, size: 32, bold: true })] }),
    p(`异议类型：${r.objection.type}`),
    p(r.objection.summary),
  ];
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C4CBCC' };
  for (const sec of orderedSections(r)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: `${sec.title}（${AUDIENCE_LABEL[sec.audience] ?? sec.audience}）`, font, bold: true, size: 26 })] }));
    if (sec.kind === 'table') {
      const cols = sec.columns ?? [];
      const row = (cells: string[], bold = false) =>
        new TableRow({
          children: cells.map(
            (c) => new TableCell({ borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ children: [new TextRun({ text: c, bold, font, size: 19 })] })] }),
          ),
        });
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            row(cols, true),
            ...sec.items.map((it) => {
              const cells = [...(it.cells ?? [])];
              if (cells.length) cells[cells.length - 1] += marks(it, cites, 'text');
              return row(cells);
            }),
          ],
        }),
      );
      continue;
    }
    sec.items.forEach((it, i) => {
      const m = marks(it, cites, 'text');
      if (sec.kind === 'qa') {
        children.push(p(`问：${it.question}`, { bold: true }), p(`答：${it.answer}${m}`));
        if (it.forbidden?.length) children.push(p(`禁止说法：${it.forbidden.map((f) => `“${f}”`).join('、')}`, { color: 'B83B2E' }));
        if (it.escalate) children.push(p(`升级条件：${it.escalate}`));
      } else if (sec.kind === 'draft') {
        for (const line of (it.text ?? '').split('\n')) children.push(p(line));
        if (m) children.push(p(m, { size: 17, color: '7D8890' }));
      } else {
        children.push(p(`${sec.kind === 'steps' ? `${i + 1}. ` : '• '}${it.text}${m}`));
      }
      const other = otherSources(it);
      if (sec.kind !== 'draft' && other) children.push(p(`依据：${other}`, { size: 17, color: '7D8890' }));
    });
  }
  if (cites?.list.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: '引用原文', font, bold: true, size: 26 })] }));
    children.push(p('以下文字由系统在原始文件中定位后逐字取出。', { size: 18, color: '7D8890' }));
    for (const c of cites.list) children.push(p(`［${c.n}］${citationNote(c)}`, { size: 18, color: !c.found || c.problem ? 'B83B2E' : undefined }));
  }
  children.push(
    p(''),
    p(
      `${outcome.unresolved.length ? `有 ${outcome.unresolved.length} 处内容需要重点审核。` : ''}本材料由系统生成，需经客户经理审核后使用。`,
      { size: 18, color: '7D8890' },
    ),
  );
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

/** 单个部分的 Markdown，复制给下游时默认不带来源标注。 */
export function sectionToMarkdown(sec: Section, withSources = false): string {
  if (sec.kind === 'draft') return sec.items.map((it) => it.text ?? '').join('\n\n');
  const out: string[] = [`## ${sec.title}`, ''];
  if (sec.kind === 'table') {
    const cols = sec.columns ?? [];
    out.push(`| ${cols.map(mdEscape).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
    for (const it of sec.items) out.push(`| ${(it.cells ?? []).map(mdEscape).join(' | ')} |`);
  } else {
    sec.items.forEach((it, i) => out.push(...itemMd(sec, it, i + 1, withSources)));
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------- 运行记录

const AGENT_NAME: Record<string, string> = { ops: '应答 Agent', review: '检查 Agent' };
const TRIGGER_NAME: Record<string, string> = { initial: '首次生成', followup: '追问后', rework: '按检查意见修改后' };

function clock(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 一次运行的完整记录（Markdown）：输入、两个 agent 的每一步和工具调用、每一轮检查发现的问题、每一轮的产出。
 * 内容全部取自本次运行的事件记录，不做改写。
 */
export function toRunRecord(state: RunState, opts: { model?: string; thinking?: boolean } = {}): string {
  const out: string[] = [];
  const title = state.outcome?.result.objection.title ?? state.rounds.at(-1)?.result.objection.title ?? state.noticeTitle;
  out.push(`# 运行记录：${title}`, '');
  out.push(`- 开始时间：${clock(state.startedAt)}`);
  if (state.finishedAt) out.push(`- 用时：${Math.round((state.finishedAt - state.startedAt) / 1000)} 秒`);
  if (opts.model) out.push(`- 模型：${opts.model}${opts.thinking === undefined ? '' : opts.thinking ? '（开启深度思考）' : '（关闭深度思考）'}`);
  out.push(`- 工具调用：${state.toolLog.length} 次；产出轮数：${state.rounds.length}`);
  const status = state.outcome?.status;
  out.push(`- 结果：${status === 'passed' ? '检查通过' : status === 'unresolved' ? `检查后仍有 ${state.outcome?.unresolved.length ?? 0} 个必须修改的问题，已标出` : status === 'review_failed' ? '检查环节没有完成' : state.error ? `中断：${state.error}` : '未完成'}`, '');

  out.push('## 一、输入', '', '案例材料：', '', '```', state.noticeText.trim(), '```', '');
  state.requests.forEach((r, i) => out.push(`${i === 0 ? '应答要求' : `追问 ${i}`}：${r}`, ''));

  out.push('## 二、过程', '');
  for (const e of state.timeline) {
    switch (e.kind) {
      case 'phase':
        out.push('', `### ${AGENT_NAME[e.agent] ?? e.agent}：${e.label}`, '');
        break;
      case 'model':
        if (e.status !== 'done') break;
        out.push(`- 第 ${e.step} 步（${((e.ms ?? 0) / 1000).toFixed(1)} 秒）${e.toolCalls?.length ? `，调用：${e.toolCalls.join('、')}` : ''}`);
        if (e.reasoning) out.push(`  - 思考摘录：${e.reasoning.replace(/\s+/g, ' ').slice(0, 220)}${e.reasoning.length > 220 ? '…' : ''}`);
        break;
      case 'tool': {
        const s = summarizeTool(e.entry);
        out.push(`  - ${e.entry.ref} ${TOOL_LABELS[e.entry.name] ?? e.entry.name}：${s.args}${s.result ? ` → ${s.result}` : ''}`);
        break;
      }
      case 'warn':
        out.push(`  - 提示：${e.text}`);
        break;
      case 'submitted':
        out.push(`  - 已提交${e.agent === 'ops' ? '产出' : '检查结果'}`);
        break;
      case 'review': {
        const must = e.review.issues.filter((i) => i.severity === '必须修改');
        out.push('', `**检查结论（第 ${e.round} 轮产出）**：${e.review.passed ? '通过' : `发现 ${must.length} 个必须修改的问题`}${e.willRework ? '，退回修改' : ''}。${e.review.summary}`, '');
        for (const c of e.review.checks ?? []) out.push(`- 核对项｜${c.item}：${c.result}${c.refs ? `（${c.refs}）` : ''}`);
        for (const i of e.review.issues) {
          out.push(`- ${i.id}［${i.severity}］${i.item_id || i.section_id || '整体'}：${i.problem}`);
          if (i.basis) out.push(`  - 依据：${i.basis}`);
          if (i.suggestion) out.push(`  - 修改意见：${i.suggestion}`);
        }
        out.push('');
        break;
      }
      case 'error':
        out.push(`- 出错：${e.text}`);
        break;
    }
  }
  out.push('');

  out.push('## 三、各轮产出', '');
  for (const r of state.rounds) {
    out.push(`### 第 ${r.round} 轮（${TRIGGER_NAME[r.trigger] ?? r.trigger}）`, '');
    if (r.changedItems.length) out.push(`与上一轮相比改动的条目：${r.changedItems.join('、')}`, '');
    out.push(toMarkdown({ result: r.result }, { withSources: true }).replace(/^# /m, '#### ').replace(/^## /gm, '##### '), '');
  }
  return out.join('\n');
}
