import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolContext, executeTool, toolDefs } from '../src/core/tools.ts';
import { validateResult, validateReview } from '../src/core/validate.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../src/shared/knowledge.generated.ts';
import { CASE_TEXT, sampleResult } from './fixtures.ts';

function ctxFor(text: string) {
  return createToolContext({ noticeText: text, references: REFERENCES, products: PRODUCTS.products, calendar: CALENDAR });
}

test('tools：定义完整，按角色区分提交工具', () => {
  const ops = toolDefs('ops', Object.keys(REFERENCES), { rules: true }).map((d) => d.function.name);
  const review = toolDefs('review', Object.keys(REFERENCES)).map((d) => d.function.name);
  assert.deepEqual(ops, ['read_reference', 'get_product', 'find_quote', 'calculate', 'compare', 'search_rules', 'read_document', 'submit_result']);
  assert.equal(review.at(-1), 'submit_review');
  assert.ok(!review.includes('submit_result'));
});

test('tools：编号按 agent 递增，并写入调用记录', () => {
  const ctx = ctxFor(CASE_TEXT);
  const a = executeTool(ctx, 'ops', 1, 'calculate', { expression: '1+1' });
  const b = executeTool(ctx, 'ops', 1, 'calculate', { expression: '2+2' });
  const c = executeTool(ctx, 'review', 1, 'calculate', { expression: '3+3' });
  assert.deepEqual([a.ref, b.ref, c.ref], ['T1', 'T2', 'V1']);
  assert.equal(ctx.log.length, 3);
  assert.equal(ctx.log[2].agent, 'review');
});

test('tools：read_reference 接受多种写法', () => {
  const ctx = ctxFor(CASE_TEXT);
  assert.equal(executeTool(ctx, 'ops', 1, 'read_reference', { name: 'types/业绩回撤与赎回' }).result.name, 'types/业绩回撤与赎回');
  assert.equal(executeTool(ctx, 'ops', 1, 'read_reference', { name: '业绩回撤与赎回.md' }).result.name, 'types/业绩回撤与赎回');
  assert.equal(executeTool(ctx, 'ops', 1, 'read_reference', { name: 'segments/高净值客户' }).result.name, 'segments/高净值客户');
  assert.equal(executeTool(ctx, 'ops', 1, 'read_reference', { name: '普通理财客户' }).result.name, 'segments/普通理财客户');
  const miss = executeTool(ctx, 'ops', 1, 'read_reference', { name: '不存在' });
  assert.equal(miss.ok, false);
  assert.ok(Array.isArray(miss.result.available));
});

test('tools：get_product 按产品名称查事实卡，并列出未提供的字段', () => {
  const ctx = ctxFor(CASE_TEXT);
  const hit = executeTool(ctx, 'ops', 1, 'get_product', { name: '“稳健增强1号”' }).result as { found: boolean; not_provided: string[] };
  assert.equal(hit.found, true);
  assert.ok(hit.not_provided.includes('数据截至日'));
  assert.ok(hit.not_provided.some((k) => k.startsWith('赎回规则')));
  const miss = executeTool(ctx, 'ops', 1, 'get_product', { name: '进取成长2号' });
  assert.equal(miss.result.found, false);
  assert.match(String(miss.result.message), /待核实/);
});

test('tools：find_quote 在案例材料中核对', () => {
  const ctx = ctxFor(CASE_TEXT);
  const hit = executeTool(ctx, 'ops', 1, 'find_quote', { text: '近3个月产品收益-0.6%，同类平均收益-1.1%' });
  assert.equal(hit.result.found, true);
  const loose = executeTool(ctx, 'ops', 1, 'find_quote', { text: '近 1 个月产品回撤 1.8%' });
  assert.equal(loose.result.found, true, '忽略空白');
  const miss = executeTool(ctx, 'ops', 1, 'find_quote', { text: '近1个月产品亏损1.8%' });
  assert.equal(miss.result.found, false);
});

test('tools：calculate（回撤和收益的差值）', () => {
  const ctx = ctxFor(CASE_TEXT);
  const r = executeTool(ctx, 'ops', 1, 'calculate', { expression: '同类 - 产品', variables: { 同类: 2.4, 产品: 1.8 }, decimals: 1 });
  assert.equal(r.result.result, '0.6');
  const neg = executeTool(ctx, 'ops', 1, 'calculate', { expression: '(-0.6) - (-1.1)', decimals: 1 });
  assert.equal(neg.result.result, '0.5');
  const bad = executeTool(ctx, 'ops', 1, 'calculate', { expression: '同类 * 2' });
  assert.equal(bad.ok, false);
});

test('tools：compare（两个负收益谁的跌幅小）', () => {
  const ctx = ctxFor(CASE_TEXT);
  const smaller = executeTool(ctx, 'ops', 1, 'compare', { op: 'number', left: '1.8', operator: '<', right: '2.4' });
  assert.equal(smaller.result.result, true);
  const higher = executeTool(ctx, 'ops', 1, 'compare', { op: 'number', left: '-0.6', operator: '>', right: '-1.1' });
  assert.equal(higher.result.result, true);
});

test('validate：合格的结果通过', () => {
  const v = validateResult(sampleResult());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test('validate：结构错误会逐条指出', () => {
  const r = sampleResult();
  r.sections[0].items[0].sources = [];
  (r.sections[1].items[0] as { cells: string[] }).cells = ['只有一列'];
  r.sections[2].items[0].sources = [{ tag: '案例材料' }];
  (r.task.questions[0] as { category: string }).category = '随便';
  r.sections.push({ ...r.sections[0] });
  const v = validateResult(r);
  assert.equal(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /至少一条 sources/);
  assert.match(all, /cells 有 1 个/);
  assert.match(all, /需要 quote/);
  assert.match(all, /category 只能是/);
  assert.match(all, /section id 重复/);
});

test('validate：检查结果', () => {
  assert.equal(validateReview({ passed: true, summary: 'ok', checks: [], issues: [] }).ok, true);
  const bad = validateReview({
    passed: true,
    summary: 'x',
    checks: [],
    issues: [{ id: 'R1', severity: '必须修改', section_id: 'S1', item_id: '', problem: 'p', basis: 'b', suggestion: 's' }],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /passed 应为 false/);
  const filled = validateReview({ passed: false, summary: 'x', checks: [], issues: [{ id: 'R1', severity: '建议', section_id: 'S1', problem: 'p', suggestion: 's' }] });
  assert.equal(filled.ok, true);
  assert.equal(filled.value!.issues[0].repeated, false);
  assert.equal(filled.value!.issues[0].item_id, '');
});
