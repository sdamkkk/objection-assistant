// 示例案例和示例要求。示例只是预先填好的文字，处理过程仍然实时调用模型。

export interface CaseInput {
  /** 客户原话 */
  words: string;
  /** 已知的产品信息 */
  facts: string;
  /** 客户情况（可以不填） */
  customer: string;
  /** 业务日期，YYYY-MM-DD：规则库只提供这一天以前发布的规定 */
  date: string;
}

export const NO_CUSTOMER_INFO = '客户经理没有提供这位客户的持有金额、买入时间、账户盈亏和风险测评结果。';

/** 把客户经理填写的几栏拼成给 agent 的案例材料。 */
export function buildCaseText(c: CaseInput): string {
  return [`业务日期：${c.date}`, '', '【客户原话】', c.words.trim(), '', '【已知的产品信息】', c.facts.trim() || '（没有填写）', '', '【客户情况】', c.customer.trim() || NO_CUSTOMER_INFO].join('\n');
}

export function caseTitle(c: CaseInput): string {
  const product = /[“"「]([^”"」]{2,20})[”"」]/.exec(c.facts)?.[1];
  const head = c.words.trim().replace(/\s+/g, ' ').slice(0, 24);
  return `${product ? `${product}：` : ''}${head}${c.words.trim().length > 24 ? '…' : ''}`;
}

export interface SampleCase {
  id: string;
  label: string;
  kind: string;
  origin: '题目材料' | '自写（泛化测试）';
  input: Omit<CaseInput, 'date'>;
  requests: { label: string; text: string }[];
}

/** 题目的应答要求（原话） */
export const REQUEST_BOTH = '请分别面向高净值客户和普通理财客户输出应答，并在生成前考虑当前适用的业务规范、监管要求和表达口径。';

export const SAMPLES: SampleCase[] = [
  {
    id: 'q1',
    label: '题目案例：固收+回撤，问要不要赎回',
    kind: '业绩回撤与赎回',
    origin: '题目材料',
    input: {
      words: '最近市场大跌，你们的固收+产品也亏了，是不是产品不行？我是不是应该马上赎回？',
      facts: '客户购买的产品为“稳健增强1号”，为固收+产品，不承诺保本保收益。\n近1个月产品回撤1.8%，同类平均回撤2.4%。\n近3个月产品收益-0.6%，同类平均收益-1.1%。',
      customer: '',
    },
    requests: [
      { label: '两版话术（题目原话）', text: REQUEST_BOTH },
      { label: '只出普通理财客户版', text: '请面向普通理财客户输出应答话术。' },
    ],
  },
  {
    id: 'g1',
    label: '泛化：客户要求保证能涨回来',
    kind: '业绩回撤与赎回',
    origin: '自写（泛化测试）',
    input: {
      words: '我买的时候你们说这个产品很稳的，现在亏成这样。你给我个准话，年底前能不能涨回来？涨不回来我就去投诉。',
      facts: '客户购买的产品为“稳健增强1号”，为固收+产品，不承诺保本保收益。\n近1个月产品回撤1.8%，同类平均回撤2.4%。\n近3个月产品收益-0.6%，同类平均收益-1.1%。',
      customer: '客户 3 个月前买入，持有 20 万元。客户提到要投诉。',
    },
    requests: [{ label: '普通理财客户版', text: '请面向普通理财客户输出应答话术，并说明这种情况客户经理应该怎么处理。' }],
  },
  {
    id: 'g2',
    label: '泛化：嫌收益比别家低',
    kind: '其他',
    origin: '自写（泛化测试）',
    input: {
      words: '我朋友在别的银行买的固收+，今年赚了 3 个点，你们这个才 1 个点多。是不是你们管得不行？帮我换一个收益高的。',
      facts: '客户购买的产品为“稳健增强1号”，为固收+产品，不承诺保本保收益。\n今年以来产品收益1.2%，同类平均收益1.5%。',
      customer: '',
    },
    requests: [{ label: '两版话术', text: '请分别面向高净值客户和普通理财客户输出应答话术。' }],
  },
];

/** 把示例案例拼成案例材料（验证页用）。 */
export function sampleNotice(id: string, date: string): { label: string; text: string; origin: string; date: string } {
  const s = SAMPLES.find((x) => x.id === id) ?? SAMPLES[0];
  return { label: s.label, text: buildCaseText({ ...s.input, date }), origin: s.origin, date };
}
