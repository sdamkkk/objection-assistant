// 本地检查界面用的预设模型回复（模拟 DeepSeek 的流式返回）。只用于本地检查，不会部署；内容是手写的，不是模型的输出。
let seq = 0;
const call = (name, args) => ({ index: 0, id: `call_${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const Q_DRAWDOWN = '近1个月产品回撤1.8%，同类平均回撤2.4%';
const Q_RETURN = '近3个月产品收益-0.6%，同类平均收益-1.1%';
const Q_NOGUARANTEE = '不承诺保本保收益';
const LAW_PROMISE = { tag: '法规原文', doc: 'R06', quote: '违规承诺收益、本金不受损失或者限定损失金额', note: '第二十四条' };
const LAW_FORECAST = { tag: '法规原文', doc: 'R06', quote: '预测基金投资业绩，或者宣传预期收益率', note: '第二十四条' };
const LAW_OWN = { tag: '法规原文', doc: 'R09', quote: '投资者应根据自身需求及风险承受能力自主选择、审慎决策，并承担风险', note: '第三条' };
const LAW_PAST = { tag: '法规原文', doc: 'R05', quote: '基金的过往业绩并不预示其未来表现', note: '第六条' };

function result(flawed) {
  return {
    task: {
      deliverables: ['高净值客户版话术', '普通理财客户版话术'],
      user_situation: [
        { item: '持有产品', value: '稳健增强1号（固收+，不承诺保本保收益）', basis: '案例材料' },
        { item: '买入时间、持有金额、账户盈亏', value: '未说明', basis: '未提供' },
        { item: '风险测评结果', value: '未说明', basis: '未提供' },
      ],
      questions: [
        { id: 'Q1', text: '是不是产品不行', category: '需要计算或判断' },
        { id: 'Q2', text: '是不是应该马上赎回', category: '超出边界' },
      ],
    },
    objection: { type: '业绩回撤与赎回', title: '稳健增强1号：净值回撤后质疑产品并询问是否赎回', summary: '客户因产品近期下跌而担心，质疑产品是不是不行，并问要不要马上赎回。' },
    sections: [
      {
        id: 'S1', title: '应答要点', audience: '客户经理', kind: 'list',
        items: [
          { id: 'S1-1', text: '客户的话有三层：担心亏损；质疑产品是不是不行；想知道要不要马上赎回。三层都要回应。', sources: [{ tag: '案例材料', quote: '是不是产品不行？我是不是应该马上赎回？' }] },
          { id: 'S1-2', text: '可以确认的事实：近 1 个月产品回撤 1.8%，同类平均 2.4%，少 0.6 个百分点；近 3 个月产品收益 -0.6%，同类平均 -1.1%，都是负的，产品少亏 0.5 个百分点。', sources: [{ tag: '案例材料', quote: Q_DRAWDOWN }, { tag: '案例材料', quote: Q_RETURN }, { tag: '工具计算', ref: 'T13,T14,T15' }] },
          { id: 'S1-3', text: '这次不能说的：不承诺收益或保本，不预测后面的涨跌，不替客户决定赎不赎。两版话术适用同一套红线。', sources: [LAW_PROMISE, LAW_FORECAST, LAW_OWN, { tag: '业务规则', note: 'P14' }] },
        ],
      },
      {
        id: 'S2', title: '高净值客户版话术', audience: '高净值客户（话术）', kind: 'draft',
        items: [
          { id: 'S2-1', text: '您好，看到净值回落，有顾虑是难免的。我先把这只产品目前的数据跟您交代清楚。', sources: [{ tag: '业务规则', note: '客群指引：高净值客户' }] },
          {
            id: 'S2-2',
            text: `稳健增强1号是固收+产品，不承诺保本保收益。近1个月它的回撤是1.8%，也就是这一个月里从高点到低点最多回落了1.8%，同期同类平均是2.4%，低0.6个百分点；近3个月收益是-0.6%，同类平均是-1.1%，都是负的，它少亏0.5个百分点。${flawed ? '可以看到它的回撤控制好于同类。' : ''}需要说明的是，这是短期的、过去的数据，同类的口径和数据截至日我还在向产品部门确认，过往业绩也不预示未来表现。`,
            sources: [{ tag: '案例材料', quote: Q_NOGUARANTEE }, { tag: '案例材料', quote: Q_DRAWDOWN }, { tag: '案例材料', quote: Q_RETURN }, { tag: '工具计算', ref: 'T13,T14' }, LAW_PAST, { tag: '业务规则', note: 'P04' }],
          },
          { id: 'S2-3', text: '所以单看这两组数据，得不出产品行或者不行的结论。至于要不要赎回，要由您来定。可以放到整体配置里看：这笔资金的用途和期限，它在您整体资产里的占比，组合能承受多大的波动，以及赎回的规则和费用。', sources: [LAW_OWN, { tag: '业务规则', note: 'P05、P10' }] },
          { id: 'S2-4', text: '您方便的话，我们约个时间把持仓过一遍。赎回的费用和到账时间我先查好，近期的运作说明我向产品部门申请，拿到后一并发给您。', sources: [{ tag: '业务规则', note: '客群指引：高净值客户' }, { tag: '材料未说明', note: '赎回规则和费用' }] },
        ],
      },
      {
        id: 'S3', title: '普通理财客户版话术', audience: '普通理财客户（话术）', kind: 'draft',
        items: [
          { id: 'S3-1', text: '您好，看到产品往下跌，担心是难免的，我跟您把情况说清楚。', sources: [{ tag: '业务规则', note: 'P13' }] },
          { id: 'S3-2', text: '稳健增强1号是固收+产品，大部分钱投在债券上，小部分投在股票这类波动大的资产上，所以净值会有涨有跌，它也不承诺保本保收益。', sources: [{ tag: '案例材料', quote: Q_NOGUARANTEE }, { tag: '业务规则', note: 'P07' }] },
          { id: 'S3-3', text: '数据上，近1个月它从最高点到最低点最多回落了1.8%，同类产品平均回落2.4%；近3个月它的收益是-0.6%，同类平均是-1.1%，都是亏的，它亏得少一些。不过这只是最近一段时间的数据，过去的表现不代表以后。', sources: [{ tag: '案例材料', quote: Q_DRAWDOWN }, { tag: '案例材料', quote: Q_RETURN }, LAW_PAST] },
          { id: 'S3-4', text: '赎不赎由您决定。您可以先想三件事：这笔钱近期要不要用；净值再波动，您能不能接受；风险测评是不是一年内做的、情况有没有变化。您买入的时间和账户的实际盈亏，我可以和您一起看一下；赎回的费用和到账时间，我也帮您查好。', sources: [LAW_OWN, { tag: '业务规则', note: 'P09、P10' }] },
        ],
      },
      {
        id: 'S4', title: '追问应对', audience: '客户经理', kind: 'qa',
        items: [
          { id: 'S4-1', question: '那后面到底会不会涨回来？', answer: '后面的涨跌我没法判断。这只产品不承诺保本保收益，过往业绩也不预示未来表现。我能做的是把它的情况和赎回的规则跟您讲清楚，由您来决定。', forbidden: ['很快会涨回来', '已经到底了'], escalate: '客户反复要求保证收益或书面承诺的，按内部流程上报。', sources: [LAW_FORECAST, { tag: '业务规则', note: 'C02' }] },
          { id: 'S4-2', question: '你就直接告诉我，赎还是不赎？', answer: '这个决定得您来做，我不能替您定。您告诉我这笔钱大概什么时候要用、能接受多大的波动，我把赎回的费用和到账时间查清楚，您就好判断了。', forbidden: ['建议您继续持有', '先赎出来观望'], escalate: '客户情绪激烈或表示要投诉的，按内部流程上报。', sources: [LAW_OWN, { tag: '业务规则', note: 'C03、P10' }] },
        ],
      },
      {
        id: 'S5', title: '需要向客户确认的信息', audience: '客户经理', kind: 'list',
        items: [
          { id: 'S5-1', text: '买入时间、持有金额和账户的实际盈亏：产品区间收益为负，不等于这位客户的账户亏损；确认后才能谈客户自己的情况。', sources: [{ tag: '材料未说明', note: '客户的买入时间和账户盈亏' }, { tag: '业务规则', note: 'P09' }] },
          { id: 'S5-2', text: '这笔资金的用途和期限，风险测评是否还在有效期内、情况有没有变化：决定赎回问题怎么展开。', sources: [{ tag: '法规原文', doc: 'R09', quote: '普通投资者风险承受能力评估结果有效期原则上不得超过十二个月', note: '第七条' }, { tag: '业务规则', note: 'P10' }] },
        ],
      },
      {
        id: 'S6', title: '待核实事项', audience: '客户经理', kind: 'list',
        items: [
          { id: 'S6-1', text: '数据截至日、“同类”的口径和数据来源：两版话术里的同类对比都依赖它，向产品部门核实。', sources: [{ tag: '产品资料', note: '数据截至日、同类的口径和数据来源：未提供' }, { tag: '业务规则', note: 'P04' }] },
          { id: 'S6-2', text: '赎回的开放安排、费用和到账时间：客户问到赎回时要用，向产品部门核实或查产品文件。', sources: [{ tag: '产品资料', note: '赎回规则：未提供' }, { tag: '业务规则', note: 'P11' }] },
          { id: 'S6-3', text: '产品的监管类别未说明：本次引用的是公募基金销售的规定，如不是公募基金，应改按对应的销售管理规定核对，向合规部门核实。', sources: [{ tag: '业务规则', note: 'P15' }] },
          { id: 'S6-4', text: '近 1 个月、近 3 个月是短区间数据，只用于答复这位客户，不要做成宣传材料或群发。', sources: [{ tag: '法规原文', doc: 'R05', quote: '展示的任意业绩区间均应当超过 6 个月', note: '第四条' }, { tag: '业务规则', note: 'P06' }] },
        ],
      },
    ],
  };
}

export const RESULT_V1 = result(true);
export const RESULT = result(false);

const REVIEW_ISSUE = {
  passed: false,
  summary: '数字和引用核对无误；高净值客户版有 1 处评价性表述需要修改。',
  checks: [
    { item: '数字核对', result: '4 个数字与案例材料一致，两个差值重算一致', refs: 'V1,V2,V3,V4' },
    { item: '法规引用', result: '核对了 2 条，均在原文中找到，条号一致', refs: 'V5,V6' },
    { item: '合规红线', result: '逐句对照 C01–C13，发现 1 处' },
  ],
  issues: [
    { id: 'R1', severity: '必须修改', section_id: 'S2', item_id: 'S2-2', problem: '高净值客户版写了“回撤控制好于同类”，这是对业绩的评价；材料只支持“回撤小于同类平均”这一事实，普通理财客户版也没有这句话。', basis: '合规口径 C05；R05 第十五条；易错点 P05、P14', suggestion: '删去这句评价，只陈述数据和差值。', repeated: false },
    { id: 'R2', severity: '建议', section_id: 'S3', item_id: 'S3-4', problem: '最后一段略长，可以拆成两句。', basis: '客群指引：普通理财客户', suggestion: '把“帮您查好”单独成句。', repeated: false },
  ],
};
const REVIEW_PASS = {
  passed: true,
  summary: '上一轮的问题已修改；数字、引用和红线复核无误。',
  checks: [
    { item: '上一轮问题', result: 'R1 已修改：评价性表述已删除' },
    { item: '数字核对', result: '4 个数字与案例材料一致，两个差值重算一致', refs: 'V7,V8' },
    { item: '两版对比', result: '事实和红线一致，区别在详略、角度和后续安排' },
  ],
  issues: [{ id: 'R2', severity: '建议', section_id: 'S3', item_id: 'S3-4', problem: '最后一段略长，可以拆成两句。', basis: '客群指引：普通理财客户', suggestion: '把“帮您查好”单独成句。', repeated: false }],
};

export function script(role, messages) {
  const assistants = messages.filter((m) => m.role === 'assistant').length;
  const users = messages.filter((m) => m.role === 'user').length;
  if (role === 'ops') {
    if (users >= 2 && messages.at(-1).role === 'user') return { tool_calls: [call('submit_result', RESULT)] }; // 返工或追问
    if (assistants === 0)
      return { tool_calls: [call('get_product', { name: '稳健增强1号' }), call('read_reference', { name: 'types/业绩回撤与赎回' }), call('read_reference', { name: 'segments/高净值客户' }), call('read_reference', { name: 'segments/普通理财客户' })] };
    if (assistants === 1)
      return {
        tool_calls: [
          call('read_reference', { name: 'rules' }),
          call('search_rules', { query: '销售人员不得承诺收益或预测业绩', keywords: ['预测'] }),
          call('find_quote', { text: LAW_PROMISE.quote, doc_id: 'R06' }),
          call('find_quote', { text: LAW_FORECAST.quote, doc_id: 'R06' }),
          call('find_quote', { text: LAW_PAST.quote, doc_id: 'R05' }),
          call('find_quote', { text: LAW_OWN.quote, doc_id: 'R09' }),
        ],
      };
    if (assistants === 2)
      return {
        tool_calls: [
          call('find_quote', { text: Q_DRAWDOWN }),
          call('find_quote', { text: Q_RETURN }),
          call('calculate', { expression: '同类 - 产品', variables: { 同类: 2.4, 产品: 1.8 }, decimals: 1, label: '近1个月回撤：比同类平均少几个百分点' }),
          call('calculate', { expression: '产品 - 同类', variables: { 产品: -0.6, 同类: -1.1 }, decimals: 1, label: '近3个月收益：比同类平均少亏几个百分点' }),
          call('compare', { op: 'number', left: '-0.6', operator: '>', right: '-1.1', label: '近3个月产品收益是否高于同类平均' }),
        ],
      };
    return { tool_calls: [call('submit_result', RESULT_V1)] };
  }
  const isSecond = messages[0].content.includes('【上一轮的问题清单】');
  if (assistants === 0)
    return isSecond
      ? { tool_calls: [call('find_quote', { text: Q_DRAWDOWN }), call('calculate', { expression: '2.4 - 1.8', decimals: 1 })] }
      : {
          tool_calls: [
            call('find_quote', { text: Q_DRAWDOWN }),
            call('find_quote', { text: Q_RETURN }),
            call('calculate', { expression: '2.4 - 1.8', decimals: 1 }),
            call('calculate', { expression: '(-0.6) - (-1.1)', decimals: 1 }),
            call('find_quote', { text: LAW_PAST.quote, doc_id: 'R05' }),
            call('find_quote', { text: LAW_OWN.quote, doc_id: 'R09' }),
          ],
        };
  return { tool_calls: [call('submit_review', isSecond ? REVIEW_PASS : REVIEW_ISSUE)] };
}

const MOCK_THOUGHTS = [
  '先读案例：客户的话里有情绪、有质疑、还有一个要做的决定。查产品事实卡，看哪些信息没有提供。',
  '动笔之前先到规则库读原文：承诺和预测的禁止情形、投资者自主决策、过往业绩的声明。',
  '数字只能取自案例材料，先核对原文，差值用工具算，不心算。',
  '两版话术用同一套事实和红线，区别按客群指引来写。',
];
let mockStep = 0;

export function sse(res, reply, opts = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const thought = `（模拟的思考过程）${MOCK_THOUGHTS[mockStep++ % MOCK_THOUGHTS.length]}`;
  const chunks = [{ choices: [{ delta: { role: 'assistant' } }] }];
  if (opts.thinking !== false) for (const part of thought.match(/.{1,12}/g)) chunks.push({ choices: [{ delta: { reasoning_content: part } }] });
  reply.tool_calls.forEach((tc, i) => chunks.push({ choices: [{ delta: { tool_calls: [{ ...tc, index: i }] } }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
  let i = 0;
  const t = setInterval(() => {
    if (i < chunks.length) res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
    else {
      res.write('data: [DONE]\n\n');
      res.end();
      clearInterval(t);
    }
  }, 120);
}

