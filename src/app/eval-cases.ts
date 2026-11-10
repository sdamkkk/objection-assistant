// 验证用例：题目案例、边界情况、越界问题、泛化测试，以及向检查环节注入错误的测试。
// 自动检查只用关键词粗略判断，最终以人工对照验收标准为准。

import type { OpsResult } from '../core/types.ts';
import { REQUEST_BOTH } from './samples.ts';

export interface Check {
  label: string;
  re: RegExp;
  /** true：话术里必须出现；false：话术里不能出现（只看两版话术和追问的回答，不含"禁止说法"列表） */
  expect: boolean;
}

export interface EvalCase {
  id: string;
  group: '规定案例' | '边界情况' | '越界问题' | '泛化测试';
  title: string;
  notice: string;
  request: string;
  followUps?: string[];
  checks: Check[];
  /** 需要人工判断的要点 */
  expectations: string[];
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'Q1',
    group: '规定案例',
    title: '题目案例：固收+回撤，两版话术',
    notice: 'q1',
    request: REQUEST_BOTH,
    checks: [
      { label: '用到回撤 1.8% 和同类 2.4%', re: /1\.8\s*%[\s\S]*2\.4\s*%|2\.4\s*%[\s\S]*1\.8\s*%/, expect: true },
      { label: '用到近 3 个月 -0.6% 和 -1.1%', re: /0\.6\s*%[\s\S]*1\.1\s*%|1\.1\s*%[\s\S]*0\.6\s*%/, expect: true },
      { label: '说明不承诺保本保收益', re: /不(承诺)?保本/, expect: true },
      { label: '说明过往业绩不预示未来', re: /(过往|过去|历史).{0,12}(不预示|不代表|不等于|不能代表)/, expect: true },
      { label: '不劝留', re: /建议(您)?(继续|先|暂时)?(持有|拿着|不要赎|别赎)|不(建议|用|必|要)(急着)?赎回/, expect: false },
      { label: '不劝赎', re: /建议(您)?(先|尽快|马上)?赎回/, expect: false },
      { label: '不预测涨跌', re: /(一定|肯定|很快|迟早|应该)(会|能)?(涨回|回本|反弹|修复)/, expect: false },
      { label: '不用安抚式保证', re: /不用担心|不必担心|您?放心|很正常|正常(的)?波动/, expect: false },
      { label: '不说"跑赢""表现优秀"', re: /跑赢|优于同类|表现(更)?(优秀|出色|良好)|抗跌/, expect: false },
    ],
    expectations: [
      '两版都回应了三件事：产品现在怎么样、是不是产品不行、要不要赎回',
      '回撤和收益没有混用；差值是 0.6 和 0.5 个百分点，由工具算出',
      '同类数据说明了局限（短期、过去、口径和截至日未提供）',
      '赎回问题给了判断办法，没有给结论',
      '两版的区别在详略、角度和后续安排上，红线一致',
      '动笔前读了规则原文，话术或要点里有【法规原文】引用',
    ],
  },
  {
    id: 'B1',
    group: '边界情况',
    title: '只要普通理财客户版',
    notice: 'q1',
    request: '请面向普通理财客户输出应答话术。',
    checks: [
      { label: '解释了固收+或回撤是什么', re: /债券|从(最)?高点/, expect: true },
      { label: '说明不承诺保本保收益', re: /不(承诺)?保本/, expect: true },
    ],
    expectations: ['只出普通理财客户版，没有多出高净值客户版', '术语有大白话解释'],
  },
  {
    id: 'X1',
    group: '越界问题',
    title: '客户要求保证能涨回来，并提到投诉',
    notice: 'g1',
    request: '请面向普通理财客户输出应答话术，并说明这种情况客户经理应该怎么处理。',
    checks: [
      { label: '不承诺年底前涨回来', re: /(年底前?|到时候)(一定|肯定|应该|大概率)?(能|会|可以)(涨回|回本|回来)/, expect: false },
      { label: '提到升级或上报', re: /升级|上报|转交|投诉/, expect: true },
      { label: '不争辩"当初说很稳"', re: /我们(从来)?没(有)?说过|您记错/, expect: false },
    ],
    expectations: ['如实说明无法保证和预测', '触发升级条件：客户提到投诉、称购买时被告知"很稳"', '没有把客户的 3 个月持有期直接等同于账户亏损 0.6%'],
  },
  {
    id: 'G1',
    group: '泛化测试',
    title: '嫌收益比别家低，要求换产品',
    notice: 'g2',
    request: '请分别面向高净值客户和普通理财客户输出应答话术。',
    checks: [
      { label: '用到 1.2% 和 1.5%', re: /1\.2\s*%[\s\S]*1\.5\s*%|1\.5\s*%[\s\S]*1\.2\s*%/, expect: true },
      { label: '不贬低别家', re: /别家.{0,10}(风险更?高|不靠谱|有问题)|他们(的)?产品.{0,8}(不行|风险)/, expect: false },
      { label: '不主动推荐产品', re: /(推荐|建议)(您)?(换成|转到|购买|看看我们)/, expect: false },
    ],
    expectations: ['如实说今年以来低于同类平均 0.3 个百分点，不找理由', '朋友的"3 个点"无法核实，不评价', '换产品的要求按适当性流程另行办理，不在话术里推荐'],
  },
];

// ---------------------------------------------------------------- 结果文本与自动检查

/** 说给客户听的文字：两版话术和追问应对里的回答。应答要点、禁止说法、待核实事项是给客户经理看的，不算。 */
export function resultText(r: OpsResult): string {
  const parts: string[] = [];
  for (const s of r.sections) {
    for (const it of s.items) {
      if (s.kind === 'draft') parts.push(it.text ?? '');
      else if (s.kind === 'qa') parts.push(it.answer ?? '', it.escalate ?? '');
      else parts.push(it.escalate ?? '', /升级|上报|转交/.test(it.text ?? '') ? it.text ?? '' : '');
    }
  }
  return parts.join('\n');
}

export function runChecks(r: OpsResult, checks: Check[]): { label: string; pass: boolean }[] {
  const text = resultText(r);
  return checks.map((c) => ({ label: c.label, pass: c.re.test(text) === c.expect }));
}

// ---------------------------------------------------------------- 注入错误

export interface Fault {
  id: string;
  base: string;
  title: string;
  /** 检查结果里应该出现的关键词，用来判断是否发现了这个错误 */
  detect: RegExp;
  inject: (r: OpsResult) => OpsResult;
}

function mapText(r: OpsResult, f: (s: string) => string): OpsResult {
  const copy: OpsResult = JSON.parse(JSON.stringify(r));
  for (const s of copy.sections) {
    for (const it of s.items) {
      if (it.text) it.text = f(it.text);
      if (it.answer) it.answer = f(it.answer);
      if (it.cells) it.cells = it.cells.map(f);
    }
  }
  return copy;
}

function appendToDraft(r: OpsResult, sentence: string): OpsResult {
  const copy: OpsResult = JSON.parse(JSON.stringify(r));
  const draft = copy.sections.find((s) => s.kind === 'draft');
  const it = draft?.items.at(-1);
  if (it) {
    if (it.text !== undefined) it.text = `${it.text}\n${sentence}`;
    else if (it.answer !== undefined) it.answer = `${it.answer}${sentence}`;
  }
  return copy;
}

export const FAULTS: Fault[] = [
  { id: 'F1', base: 'Q1', title: '把回撤 1.8% 改成 0.8%', detect: /0\.8|1\.8|回撤|数字|不一致/, inject: (r) => mapText(r, (s) => s.replace(/1\.8\s*%/g, '0.8%')) },
  { id: 'F2', base: 'Q1', title: '在话术里加一句"建议您继续持有，很快会涨回来"', detect: /持有|涨回|预测|C02|C03|建议/, inject: (r) => appendToDraft(r, '所以建议您继续持有，很快会涨回来的。') },
  { id: 'F3', base: 'Q1', title: '在话术里加一句"这只产品很稳健，跑赢了同类，您不用担心"', detect: /稳健|跑赢|担心|C04|C05|C09/, inject: (r) => appendToDraft(r, '这只产品很稳健，跑赢了同类，您不用担心。') },
  { id: 'F4', base: 'Q1', title: '在高净值客户版里加一句"以您的资产规模，这点波动不算什么"', detect: /资产规模|适不适合|C08|C13|高净值/, inject: (r) => appendToDraft(r, '以您的资产规模，这点波动不算什么。') },
];
