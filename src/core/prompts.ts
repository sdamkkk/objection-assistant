// 拼接系统提示词和各类用户消息。服务端用 buildSystemPrompt，浏览器端用其余函数。

import { compactText } from './textfind.ts';
import type { AgentRole, OpsResult, ReviewIssue, ToolLogEntry } from './types.ts';

/** 常驻在系统提示词里的参考资料；其余（类型指引、客群指引、规则库导航）按需用 read_reference 读取。 */
export const RESIDENT_REFERENCES: { key: string; title: string }[] = [
  { key: 'pitfalls', title: '易错点说明书（pitfalls）' },
  { key: 'compliance', title: '合规口径（compliance）' },
  { key: 'output-formats', title: '产出格式（output-formats）' },
];

export function onDemandReferences(references: Record<string, string>): string[] {
  const resident = new Set(RESIDENT_REFERENCES.map((r) => r.key));
  return Object.keys(references).filter((k) => !resident.has(k));
}

export function buildSystemPrompt(role: AgentRole, skills: { ops: string; review: string }, references: Record<string, string>): string {
  const parts = [skills[role].trim(), '', '---', '', '# 常驻参考资料', ''];
  for (const r of RESIDENT_REFERENCES) {
    parts.push(`## 参考资料：${r.title}`, '', references[r.key].trim(), '');
  }
  parts.push('---', '', `可以用 read_reference 按需读取的资料：${onDemandReferences(references).join('、')}。`);
  return parts.join('\n');
}

function fence(label: string, body: string): string {
  return `<<<${label}开始>>>\n${body.trim()}\n<<<${label}结束>>>`;
}

/** 本次可用的文件库说明 */
export interface LibraryTexts {
  kb?: string;
  rules?: string;
}

function libraryBlocks(libs: LibraryTexts = {}): string[] {
  const out: string[] = ['【规则库】'];
  out.push(
    libs.rules
      ? fence('规则库', libs.rules)
      : '本次没有提供规则库（监管规则原文）。合规口径和易错点说明书只能用来理解规则，不能作为法规原文引用；需要提到规定时，写明规则名称和条号，来源标【业务规则】，并列入待核实请合规部门确认原文。',
    '',
  );
  return out;
}

/** 案例材料是按版面还原的 Markdown 时，告诉 agent 怎么读、怎么引用。 */
export const MARKDOWN_NOTICE_NOTE =
  '（材料已按原件版面整理：表格还原为 Markdown 表格，一行是一条记录。文字全部取自原件，没有增删。引用时只摘原文文字、不带 | 等表格记号，一段引文不要跨单元格。）';

export function buildOpsUserMessage(noticeText: string, request: string, libs: LibraryTexts = {}, markdown = false): string {
  return [
    '请处理下面这个客户异议案例。',
    '',
    '【案例材料】',
    ...(markdown ? [MARKDOWN_NOTICE_NOTE] : []),
    fence('案例', compactText(noticeText)),
    '',
    ...libraryBlocks(libs),
    '【客户经理的应答要求】',
    fence('要求', request),
    '',
    '请按 skill 的工作方法处理：先查产品事实卡，读取对应的类型指引和客群指引；动笔之前先到规则库读取本次适用的规定原文并核对引用；数字用工具核对和计算；最后调用 submit_result 提交。',
  ].join('\n');
}

export function buildFollowUpMessage(text: string): string {
  return [
    '【客户经理的追问或补充信息】',
    fence('追问', text),
    '',
    '请结合新的信息更新结果。已有的、不受影响的条目保持原样（包括 id），然后重新调用 submit_result 提交完整结果。',
  ].join('\n');
}

export function buildReworkMessage(issues: ReviewIssue[]): string {
  const lines = issues.map((i) =>
    [`- ${i.id}［${i.severity}］位置：${i.section_id || '（整体）'}${i.item_id ? ` / ${i.item_id}` : ''}`, `  问题：${i.problem}`, `  依据：${i.basis}`, `  修改意见：${i.suggestion}`].join('\n'),
  );
  return [
    '【检查环节退回的问题】',
    ...lines,
    '',
    '请逐条修改以上问题涉及的条目。其他条目保持原样（包括 id）。如果你认为某个问题不成立，在相应条目的 sources 中加一条"AI解读"说明理由。修改完成后，重新调用 submit_result 提交完整结果。',
  ].join('\n');
}

/** 给检查 agent 的工具调用记录：去掉资料正文，只保留调用和结果。 */
export function summarizeToolLog(log: ToolLogEntry[]): unknown[] {
  return log
    .filter((e) => e.agent === 'ops')
    .map((e) => {
      const result = e.result as Record<string, unknown>;
      if (e.name === 'read_reference') {
        return { ref: e.ref, tool: e.name, args: e.args, result: { name: result.name ?? result.error } };
      }
      if (e.name === 'get_product') {
        return { ref: e.ref, tool: e.name, args: e.args, result: { found: result.found, based_on: result.based_on } };
      }
      if (e.name === 'read_notice' || e.name === 'read_document') {
        const text = typeof result.text === 'string' ? result.text : '';
        return {
          ref: e.ref,
          tool: e.name,
          args: e.args,
          result: result.error ? { error: result.error } : { id: result.id, title: result.title, page_from: result.page_from, page_to: result.page_to, sections: result.sections, chars: text.length },
        };
      }
      return { ref: e.ref, tool: e.name, args: e.args, result };
    });
}

export function buildReviewUserMessage(opts: {
  noticeText: string;
  /** noticeText 是按版面还原的 Markdown */
  markdown?: boolean;
  requests: string[];
  result: OpsResult;
  toolLog: ToolLogEntry[];
  previousIssues: ReviewIssue[];
  libs?: LibraryTexts;
}): string {
  const requestText = opts.requests.map((r, i) => (i === 0 ? r : `（追问 ${i}）${r}`)).join('\n\n');
  const parts = [
    '请检查下面这份应答结果。',
    '',
    '【案例材料】',
    ...(opts.markdown ? [MARKDOWN_NOTICE_NOTE] : []),
    fence('案例', compactText(opts.noticeText)),
    '',
    ...libraryBlocks(opts.libs),
    '【客户经理的应答要求】',
    fence('要求', requestText),
    '',
    '【待检查的产出】',
    fence('产出', JSON.stringify(opts.result, null, 2)),
    '',
    '【应答环节的工具调用记录】',
    fence('工具记录', JSON.stringify(summarizeToolLog(opts.toolLog), null, 2)),
  ];
  if (opts.previousIssues.length) {
    parts.push('', '【上一轮的问题清单】', fence('上一轮问题', JSON.stringify(opts.previousIssues, null, 2)));
  }
  parts.push('', '请按 skill 的检查方法逐项检查，数字和引用用工具重新核对，最后调用 submit_review 提交。');
  return parts.join('\n');
}

export const NUDGE_MESSAGE: Record<AgentRole, string> = {
  ops: '请不要直接用文字回复。如果还需要查资料、读规则或计算，请继续调用工具；完成后请调用 submit_result 提交结果。',
  review: '请不要直接用文字回复。如果还需要核对，请继续调用工具；完成后请调用 submit_review 提交检查结果。',
};
