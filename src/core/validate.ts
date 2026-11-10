// 校验 agent 提交的结构。只查结构，不查内容（内容由检查 agent 判断）。

import {
  AUDIENCES,
  KINDS,
  QUESTION_CATEGORIES,
  SEVERITIES,
  SITUATION_BASIS,
  SOURCE_TAGS,
  type OpsResult,
  type ReviewResult,
} from './types.ts';

export interface Validation<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === 'string' && list.includes(v);
}

export function validateResult(input: unknown): Validation<OpsResult> {
  const errors: string[] = [];
  const e = (msg: string) => errors.push(msg);
  if (!isObj(input)) return { ok: false, errors: ['提交内容必须是 JSON 对象'] };
  const r = input;

  // task
  if (!isObj(r.task)) e('缺少 task');
  else {
    const t = r.task;
    if (!Array.isArray(t.deliverables) || !t.deliverables.every(isStr)) e('task.deliverables 必须是字符串数组');
    if (!Array.isArray(t.user_situation)) e('task.user_situation 必须是数组（没有客户情况时传空数组）');
    else
      t.user_situation.forEach((u, i) => {
        if (!isObj(u) || !nonEmpty(u.item) || !isStr(u.value)) e(`task.user_situation[${i}] 需要 item 和 value`);
        else if (!oneOf(u.basis, SITUATION_BASIS)) e(`task.user_situation[${i}].basis 只能是 ${SITUATION_BASIS.join(' / ')}`);
      });
    if (!Array.isArray(t.questions)) e('task.questions 必须是数组');
    else
      t.questions.forEach((q, i) => {
        if (!isObj(q) || !nonEmpty(q.id) || !nonEmpty(q.text)) e(`task.questions[${i}] 需要 id 和 text`);
        else if (!oneOf(q.category, QUESTION_CATEGORIES)) e(`task.questions[${i}].category 只能是 ${QUESTION_CATEGORIES.join(' / ')}`);
      });
  }

  // objection
  if (!isObj(r.objection) || !nonEmpty(r.objection.type) || !isStr(r.objection.title) || !nonEmpty(r.objection.summary)) {
    e('objection 需要 type、title、summary');
  }

  // sections
  if (!Array.isArray(r.sections) || r.sections.length === 0) e('sections 不能为空');
  else {
    const sectionIds = new Set<string>();
    const itemIds = new Set<string>();
    r.sections.forEach((s, si) => {
      const where = `sections[${si}]`;
      if (!isObj(s)) return e(`${where} 必须是对象`);
      if (!nonEmpty(s.id)) e(`${where} 缺少 id`);
      else if (sectionIds.has(s.id)) e(`section id 重复：${s.id}`);
      else sectionIds.add(s.id);
      if (!nonEmpty(s.title)) e(`${where} 缺少 title`);
      if (!oneOf(s.audience, AUDIENCES)) e(`${where}.audience 只能是 ${AUDIENCES.join(' / ')}`);
      if (!oneOf(s.kind, KINDS)) e(`${where}.kind 只能是 ${KINDS.join(' / ')}`);
      const kind = s.kind as string;
      if (kind === 'table' && (!Array.isArray(s.columns) || s.columns.length === 0 || !s.columns.every(isStr))) {
        e(`${where}（${s.title}）是 table，需要 columns`);
      }
      if (!Array.isArray(s.items) || s.items.length === 0) return e(`${where}（${s.title}）的 items 不能为空`);
      s.items.forEach((it, ii) => {
        const w = `${where}.items[${ii}]`;
        if (!isObj(it)) return e(`${w} 必须是对象`);
        if (!nonEmpty(it.id)) e(`${w} 缺少 id`);
        else if (itemIds.has(it.id)) e(`item id 重复：${it.id}`);
        else itemIds.add(it.id);
        if (kind === 'qa') {
          if (!nonEmpty(it.question) || !nonEmpty(it.answer)) e(`${w}（qa）需要 question 和 answer`);
          if (it.forbidden !== undefined && (!Array.isArray(it.forbidden) || !it.forbidden.every(isStr))) e(`${w}.forbidden 必须是字符串数组`);
        } else if (kind === 'table') {
          if (!Array.isArray(it.cells) || !it.cells.every(isStr)) e(`${w}（table）需要 cells 字符串数组`);
          else if (Array.isArray(s.columns) && it.cells.length !== s.columns.length) {
            e(`${w}（table）cells 有 ${it.cells.length} 个，与 columns 的 ${s.columns.length} 个不一致`);
          }
        } else if (!nonEmpty(it.text)) {
          e(`${w}（${kind}）需要 text`);
        }
        if (!Array.isArray(it.sources) || it.sources.length === 0) e(`${w} 需要至少一条 sources`);
        else
          it.sources.forEach((src, k) => {
            if (!isObj(src) || !oneOf(src.tag, SOURCE_TAGS)) e(`${w}.sources[${k}].tag 只能是 ${SOURCE_TAGS.join(' / ')}`);
            else if (src.tag === '案例材料' && !nonEmpty(src.quote)) e(`${w}.sources[${k}] 是"案例材料"，需要 quote`);
            else if ((src.tag === '披露文件' || src.tag === '法规原文') && (!nonEmpty(src.quote) || !(nonEmpty(src.doc) || /\b(\d{6}-\d{2}|R\d{2})\b/.test(String(src.note ?? '')))))
              e(`${w}.sources[${k}] 是"${src.tag}"，需要 quote（用 find_quote 核对过的原文片段）和 doc（文件编号，如"R06"）`);
            else if (src.tag === '工具计算' && !nonEmpty(src.ref)) e(`${w}.sources[${k}] 是"工具计算"，需要 ref（如 T3）`);
          });
      });
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors, value: r as unknown as OpsResult };
}

export function validateReview(input: unknown): Validation<ReviewResult> {
  const errors: string[] = [];
  const e = (msg: string) => errors.push(msg);
  if (!isObj(input)) return { ok: false, errors: ['提交内容必须是 JSON 对象'] };
  const r = input;
  if (typeof r.passed !== 'boolean') e('passed 必须是 true 或 false');
  if (!isStr(r.summary)) e('缺少 summary');
  if (!Array.isArray(r.checks)) e('checks 必须是数组');
  if (!Array.isArray(r.issues)) e('issues 必须是数组（没有问题时传空数组）');
  else {
    r.issues.forEach((it, i) => {
      const w = `issues[${i}]`;
      if (!isObj(it)) return e(`${w} 必须是对象`);
      if (!nonEmpty(it.id)) e(`${w} 缺少 id`);
      if (!oneOf(it.severity, SEVERITIES)) e(`${w}.severity 只能是 ${SEVERITIES.join(' / ')}`);
      if (!nonEmpty(it.problem)) e(`${w} 缺少 problem`);
      if (!isStr(it.suggestion)) e(`${w} 缺少 suggestion`);
      if (!isStr(it.section_id)) e(`${w} 缺少 section_id`);
    });
    if (typeof r.passed === 'boolean') {
      const mustFix = r.issues.some((it) => isObj(it) && it.severity === '必须修改');
      if (r.passed && mustFix) e('存在"必须修改"的问题时，passed 应为 false');
    }
  }
  if (errors.length) return { ok: false, errors };
  // 补齐可选字段
  const issues = (r.issues as Record<string, unknown>[]).map((it) => ({
    id: String(it.id),
    severity: it.severity as ReviewResult['issues'][number]['severity'],
    section_id: String(it.section_id ?? ''),
    item_id: String(it.item_id ?? ''),
    problem: String(it.problem),
    basis: String(it.basis ?? ''),
    suggestion: String(it.suggestion ?? ''),
    repeated: Boolean(it.repeated),
  }));
  return {
    ok: true,
    errors,
    value: { passed: r.passed as boolean, summary: String(r.summary), checks: r.checks as ReviewResult['checks'], issues },
  };
}
