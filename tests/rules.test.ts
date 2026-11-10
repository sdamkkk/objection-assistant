import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KnowledgeBase, type KbData } from '../src/core/kb.ts';
import { createToolContext, executeTool } from '../src/core/tools.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../src/shared/knowledge.generated.ts';
import { CASE_TEXT } from './fixtures.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'kb', 'rules');
const json = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const data: KbData = { index: json('index.json'), pages: json('pages.json'), chunks: json('chunks.json') };
const rules = (asOf: string) => new KnowledgeBase(data, { code: 'rules', asOf });

test('规则库：导航里写的条文都能在原文中找到', () => {
  const k = rules('2026-11-10');
  const cases: [string, string, RegExp][] = [
    ['R06', '违规承诺收益、本金不受损失或者限定损失金额', /第二十四条/],
    ['R06', '预测基金投资业绩，或者宣传预期收益率', /第二十四条/],
    ['R06', '杜绝诱导投资人短期申赎、频繁申赎行为', /第十七条/],
    ['R06', '不得擅自拒绝接受投资人的申请', /第十九条/],
    ['R05', '基金的过往业绩并不预示其未来表现', /第六条/],
    ['R05', '应当使用可比的数据来源、统计方法和比较期间', /第七条/],
    ['R05', '夸大或者片面宣传基金管理人、基金经理或者其管理的基金的过往业绩', /第十五条/],
    ['R09', '投资者应根据自身需求及风险承受能力自主选择、审慎决策，并承担风险', /第三条/],
  ];
  for (const [doc, quote, article] of cases) {
    const r = k.find(doc, quote) as { found: boolean; article?: string };
    assert.equal(r.found, true, `${doc}：${quote}`);
    assert.match(String(r.article), article, `${doc}：${quote}`);
  }
});

test('规则库：按业务日期提供，晚于业务日期发布的不能用', () => {
  const early = rules('2026-01-15');
  assert.equal(early.availability('R09'), 'future', '适当性细则 2026-06-12 发布');
  assert.match(String(early.read('R09').error), /晚于业务日期/);
  assert.equal(rules('2026-11-10').availability('R09'), 'ok');
  assert.match(rules('2026-11-10').describe(), /业务日期 2026-11-10/);
});

test('规则库：工具可以检索、阅读和核对', () => {
  const ctx = createToolContext({ noticeText: CASE_TEXT, references: REFERENCES, products: PRODUCTS.products, calendar: CALENDAR, rules: rules('2026-11-10') });
  const s = executeTool(ctx, 'ops', 1, 'search_rules', { query: '销售人员不得承诺收益或预测业绩', keywords: ['预测'] }).result as { results: { id: string }[] };
  assert.ok(s.results.some((x) => x.id === 'R06'));
  assert.equal(executeTool(ctx, 'ops', 1, 'find_quote', { text: '预测基金投资业绩', doc_id: 'R06' }).result.found, true);
  assert.equal(executeTool(ctx, 'ops', 1, 'read_document', { id: 'R05', page_from: 1, page_to: 1 }).ok, true);
});
