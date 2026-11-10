// 测试用的示例数据。

import type { OpsResult, ReviewResult } from '../src/core/types.ts';
import { SAMPLES, buildCaseText } from '../src/app/samples.ts';

/** 题目案例拼成的案例材料 */
export const CASE_TEXT = buildCaseText({ ...SAMPLES[0].input, date: '2026-11-10' });

export function sampleResult(overrides: Partial<OpsResult> = {}): OpsResult {
  return {
    task: {
      deliverables: ['高净值客户版话术', '普通理财客户版话术'],
      user_situation: [
        { item: '持有产品', value: '稳健增强1号（固收+）', basis: '案例材料' },
        { item: '买入时间和账户盈亏', value: '未说明', basis: '未提供' },
      ],
      questions: [
        { id: 'Q1', text: '是不是产品不行', category: '需要计算或判断' },
        { id: 'Q2', text: '是不是应该马上赎回', category: '超出边界' },
      ],
    },
    objection: { type: '业绩回撤与赎回', title: '稳健增强1号：净值回撤后质疑产品并询问是否赎回', summary: '客户担心亏损，质疑产品，并问要不要马上赎回。' },
    sections: [
      {
        id: 'S1',
        title: '应答要点',
        audience: '客户经理',
        kind: 'list',
        items: [
          { id: 'S1-1', text: '近 1 个月产品回撤比同类平均少 0.6 个百分点。', sources: [{ tag: '工具计算', ref: 'T1' }] },
          { id: 'S1-2', text: '是否赎回由客户决定，话术只给判断办法。', sources: [{ tag: '业务规则', note: 'P10' }] },
        ],
      },
      {
        id: 'S2',
        title: '数据对照',
        audience: '客户经理',
        kind: 'table',
        columns: ['指标', '产品', '同类平均', '差值'],
        items: [{ id: 'S2-1', cells: ['近1个月回撤', '1.8%', '2.4%', '0.6 个百分点'], sources: [{ tag: '案例材料', quote: '近1个月产品回撤1.8%，同类平均回撤2.4%' }] }],
      },
      {
        id: 'S3',
        title: '追问应对',
        audience: '客户经理',
        kind: 'qa',
        items: [
          {
            id: 'S3-1',
            question: '那后面到底会不会涨回来？',
            answer: '后面的涨跌我没法判断，过往业绩也不预示未来表现。',
            forbidden: ['很快会涨回来'],
            escalate: '客户反复要求保证收益时上报',
            sources: [{ tag: '业务规则', note: 'C02' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function sampleReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { passed: true, summary: '未发现必须修改的问题', checks: [{ item: '引用核对', result: '核对了 1 条引用' }], issues: [], ...overrides };
}
