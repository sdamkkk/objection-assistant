// agent 可以调用的工具：定义（发给模型的 JSON Schema）和执行逻辑。
// 工具都与异议类型无关，只做精确的基本操作；判断交给 agent。

import { TradingCalendar, label, parseDate, type CalendarData } from './calendar.ts';
import { cmp, dec, round, toGrouped, toStr, type Rounding } from './decimal.ts';
import { evaluate } from './expr.ts';
import type { KnowledgeBase } from './kb.ts';
import { PagedText } from './paged.ts';
import { SOURCE_TAGS, type AgentRole, type ToolLogEntry } from './types.ts';

// ---------------------------------------------------------------- 定义

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    tag: { type: 'string', enum: [...SOURCE_TAGS] },
    quote: { type: 'string', description: '案例材料、法规原文或应答要求的逐字片段，须用 find_quote 核对过' },
    doc: { type: 'string', description: '法规原文填文件编号，如 R06；案例材料不填' },
    ref: { type: 'string', description: '工具调用编号，如 T3；多个用逗号分隔' },
    note: { type: 'string', description: '补充说明，如易错点编号 P01、合规口径编号 C03、产品事实卡字段名、法规条号' },
  },
  required: ['tag'],
};

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '条目编号，如 S2-1' },
    text: { type: 'string', description: 'list / steps / draft 形式使用；draft 是话术的一个段落' },
    question: { type: 'string', description: 'qa 形式：客户可能的追问' },
    answer: { type: 'string', description: 'qa 形式：可以直接说给客户听的回答' },
    forbidden: { type: 'array', items: { type: 'string' }, description: '禁止说法' },
    escalate: { type: 'string', description: '什么情况下升级' },
    cells: { type: 'array', items: { type: 'string' }, description: 'table 形式：各列内容' },
    sources: { type: 'array', items: SOURCE_SCHEMA },
  },
  required: ['id', 'sources'],
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'object',
      properties: {
        deliverables: { type: 'array', items: { type: 'string' } },
        user_situation: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              value: { type: 'string' },
              basis: { type: 'string', enum: ['案例材料', '假设', '未提供'] },
            },
            required: ['item', 'value', 'basis'],
          },
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              category: { type: 'string', enum: ['材料可直接回答', '需要计算或判断', '材料没有说明', '超出边界'] },
            },
            required: ['id', 'text', 'category'],
          },
        },
      },
      required: ['deliverables', 'user_situation', 'questions'],
    },
    objection: {
      type: 'object',
      properties: { type: { type: 'string', description: '异议类型' }, title: { type: 'string' }, summary: { type: 'string', description: '一句话概括客户的异议' } },
      required: ['type', 'title', 'summary'],
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          audience: { type: 'string', enum: ['客户经理', '高净值客户（话术）', '普通理财客户（话术）', '通用'] },
          kind: { type: 'string', enum: ['list', 'qa', 'table', 'steps', 'draft'] },
          columns: { type: 'array', items: { type: 'string' } },
          items: { type: 'array', items: ITEM_SCHEMA },
        },
        required: ['id', 'title', 'audience', 'kind', 'items'],
      },
    },
  },
  required: ['task', 'objection', 'sections'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: '没有任何"必须修改"的问题时为 true' },
    summary: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, result: { type: 'string' }, refs: { type: 'string' } },
        required: ['item', 'result'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['必须修改', '建议'] },
          section_id: { type: 'string' },
          item_id: { type: 'string', description: '整个 section 的问题填空字符串' },
          problem: { type: 'string' },
          basis: { type: 'string' },
          suggestion: { type: 'string' },
          repeated: { type: 'boolean', description: '上一轮已提出、仍未修好时为 true' },
        },
        required: ['id', 'severity', 'section_id', 'item_id', 'problem', 'basis', 'suggestion', 'repeated'],
      },
    },
  },
  required: ['passed', 'summary', 'checks', 'issues'],
};

function def(name: string, description: string, parameters: Record<string, unknown>): ToolDef {
  return { type: 'function', function: { name, description, parameters } };
}

export interface ToolFeatures {
  /** 关联了本基金的公告库 */
  kb?: boolean;
  /** 提供监管规则原文库 */
  rules?: boolean;
}

export function toolDefs(role: AgentRole, referenceNames: string[], opts: ToolFeatures = {}): ToolDef[] {
  const libs = opts.kb || opts.rules;
  const libNames = [opts.kb ? '公告库' : '', opts.rules ? '规则库' : ''].filter(Boolean).join('或');
  const common: ToolDef[] = [
    def('read_reference', '读取参考资料（类型指引、客群指引、规则库导航）。', {
      type: 'object',
      properties: { name: { type: 'string', enum: referenceNames } },
      required: ['name'],
    }),
    def('get_product', '按产品名称查询产品事实卡：产品类型、是否保本、业绩数据，以及哪些信息未提供。', {
      type: 'object',
      properties: { name: { type: 'string', description: '产品名称，如"稳健增强1号"' } },
      required: ['name'],
    }),
    def(
      'find_quote',
      libs
        ? `查找一段文字，确认引用准确，返回原文中对应的片段。不填 doc_id 时在案例材料中查找；填了则在${libNames}的那份文件中查找，并返回页码和条号。忽略空白、换行和全角半角差异；找不到时返回最接近的片段。`
        : '在案例材料中查找一段文字，确认引用准确，返回原文中对应的片段。忽略空白、换行和全角半角差异；找不到时返回最接近的片段。',
      {
        type: 'object',
        properties: libs
          ? { text: { type: 'string' }, doc_id: { type: 'string', description: `${libNames}中的文件编号，如 R06；核对案例材料时不填` } }
          : { text: { type: 'string' } },
        required: ['text'],
      },
    ),
    def('calculate', '精确计算四则运算表达式（支持 + - * / 括号、百分号、变量名）。所有数字计算都必须用它。', {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '如 "2.4 - 1.8" 或 "同类 - 产品"' },
        variables: { type: 'object', description: '变量取值，如 {"同类": 2.4, "产品": 1.8}', additionalProperties: { type: ['number', 'string'] } },
        decimals: { type: 'integer', description: '保留小数位数；不填则不舍入' },
        rounding: { type: 'string', enum: ['half_up', 'down', 'up', 'half_even'], description: 'half_up=四舍五入，down=截位（舍去），up=进位，half_even=银行家舍入' },
        label: { type: 'string', description: '这一步算的是什么' },
      },
      required: ['expression'],
    }),
    def('compare', '比较工具。op=number：比较数值 left operator right；op=date：比较日期 left operator right；op=date_in_range：判断 date 是否在 start 与 end 之间（end 为 null 表示没有结束日）。', {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['number', 'date', 'date_in_range'] },
        left: { type: 'string' },
        operator: { type: 'string', enum: ['>', '>=', '<', '<=', '=='] },
        right: { type: 'string' },
        date: { type: 'string' },
        start: { type: 'string' },
        end: { type: ['string', 'null'] },
        include_start: { type: 'boolean', description: '默认 true' },
        include_end: { type: 'boolean', description: '默认 true' },
        label: { type: 'string', description: '这一步比较的是什么' },
      },
      required: ['op'],
    }),
  ];
  if (opts.kb) {
    common.push(
      def('search_notices', '在本基金的公告库中检索（只包含当前公告日期及以前披露的文件）。返回最相关的段落（文件、页码、所在章节、片段）；query 和 keywords 都不填时列出文件清单。', {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找的内容，用一句话描述，如 "最小申购赎回单位是多少份"' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选。必须出现的关键词，原文中原样出现的段落会排在前面，如 ["最小申购赎回单位"]' },
          types: { type: 'array', items: { type: 'string' }, description: '按类型过滤，可填大类（法律文件、定期报告、临时公告）或小类（招募说明书、产品资料概要、季度报告、基金经理变更等）' },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
          limit: { type: 'integer', description: '返回的段落数，默认 8，最多 20' },
        },
      }),
    );
  }
  if (opts.rules) {
    common.push(
      def('search_rules', '在规则库（监管规则和自律规则的原始文件，只含业务日期以前发布的）中检索，返回最相关的条文段落；query 和 keywords 都不填时列出文件清单。', {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找的内容，用一句话描述，如 "销售人员不得承诺收益或预测业绩"' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选。必须出现的关键词，如 ["预测"]' },
          types: { type: 'array', items: { type: 'string' }, description: '按规则简称或类别过滤，如 ["销售机构办法"]' },
          limit: { type: 'integer', description: '返回的段落数，默认 8，最多 20' },
        },
      }),
    );
  }
  if (libs) {
    common.push(
      def('read_document', `阅读${libNames}中某份文件（由原件转换的 Markdown，保留标题层级和表格）。填 section 读取检索结果中的某一段及其后文，或填页码范围；单次最多约 6000 字。`, {
        type: 'object',
        properties: {
          id: { type: 'string', description: '文件编号，如 R06' },
          section: { type: 'string', description: '检索结果中的分段编号，如 R06#12' },
          page_from: { type: 'integer' },
          page_to: { type: 'integer' },
        },
        required: [],
      }),
    );
  }
  if (role === 'ops') {
    common.push(def('submit_result', '提交最终的应答结果。结构见产出格式（output-formats）。', RESULT_SCHEMA));
  } else {
    common.push(def('submit_review', '提交检查结果（问题清单）。', REVIEW_SCHEMA));
  }
  return common;
}

export const SUBMIT_TOOLS = ['submit_result', 'submit_review'];

// ---------------------------------------------------------------- 执行

export interface ToolContext {
  notice: PagedText;
  kb?: KnowledgeBase;
  rules?: KnowledgeBase;
  references: Record<string, string>;
  products: Record<string, unknown>[];
  calendar: TradingCalendar;
  log: ToolLogEntry[];
  counters: Record<AgentRole, number>;
}

export function createToolContext(opts: {
  noticeText: string;
  /** 当前公告的分页文字；不传时整份当作一页 */
  noticePages?: string[];
  references: Record<string, string>;
  products: Record<string, unknown>[];
  calendar: CalendarData;
  kb?: KnowledgeBase;
  rules?: KnowledgeBase;
}): ToolContext {
  return {
    notice: opts.noticePages?.length ? new PagedText(opts.noticePages) : PagedText.fromText(opts.noticeText),
    kb: opts.kb,
    rules: opts.rules,
    references: opts.references,
    products: opts.products,
    calendar: new TradingCalendar(opts.calendar),
    log: [],
    counters: { ops: 0, review: 0 },
  };
}

type Args = Record<string, unknown>;

function str(a: Args, key: string, required = true): string {
  const v = a[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`缺少参数 ${key}`);
    return '';
  }
  return String(v);
}

function resolveRef(name: string, refs: Record<string, string>): string | undefined {
  const n = name.trim().replace(/\.md$/, '');
  if (refs[n] !== undefined) return n;
  if (refs[`types/${n}`] !== undefined) return `types/${n}`;
  return Object.keys(refs).find((k) => k.endsWith(`/${n}`) || k === n.replace(/^references\//, ''));
}

function findProduct(name: string, products: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const key = name.replace(/[\s"“”「」《》]/g, '');
  if (!key) return undefined;
  return products.find((p) => {
    const n = String(p['产品名称'] ?? '').replace(/\s/g, '');
    return Boolean(n) && (n === key || key.includes(n) || n.includes(key));
  });
}

/** 按文件编号找到它所在的库 */
export function libraryOf(ctx: { kb?: KnowledgeBase; rules?: KnowledgeBase }, id: string): KnowledgeBase | undefined {
  if (ctx.kb?.has(id)) return ctx.kb;
  if (ctx.rules?.has(id)) return ctx.rules;
  return undefined;
}

function libraryMissing(ctx: ToolContext, id: string): string {
  if (!ctx.kb && !ctx.rules) return '本次没有关联公告库或规则库，不能指定文件编号。';
  const names = [ctx.kb ? `公告库（${ctx.kb.index.code}-NN）` : '', ctx.rules ? '规则库（R 开头）' : ''].filter(Boolean).join('、');
  return `没有编号为 ${id} 的文件。可用的有：${names}。`;
}

const OPS: Record<string, (c: number) => boolean> = {
  '>': (x) => x > 0,
  '>=': (x) => x >= 0,
  '<': (x) => x < 0,
  '<=': (x) => x <= 0,
  '==': (x) => x === 0,
};
const OP_TEXT: Record<string, string> = { '>': '大于', '>=': '大于或等于', '<': '小于', '<=': '小于或等于', '==': '等于' };

function runTool(ctx: ToolContext, name: string, a: Args): Record<string, unknown> {
  switch (name) {
    case 'read_reference': {
      const key = resolveRef(str(a, 'name'), ctx.references);
      if (!key) return { error: `没有这份资料：${a.name}`, available: Object.keys(ctx.references) };
      return { name: key, content: ctx.references[key] };
    }
    case 'get_product': {
      const name = str(a, 'name', false) || str(a, 'code', false);
      if (!name) throw new Error('缺少参数 name');
      const p = findProduct(name, ctx.products);
      if (!p) {
        return {
          found: false,
          message: `产品库中没有"${name}"。目前收录：${ctx.products.map((x) => String(x['产品名称'])).join('、')}。产品信息只能依据案例材料，材料没有的列入待核实。`,
        };
      }
      const missing = Object.entries(p).filter(([, v]) => v === '未提供').map(([k]) => k);
      return { found: true, product: p, not_provided: missing, note: '标为"未提供"的字段不得自行补充；话术需要用到的，列入待核实或需要向客户确认的信息。' };
    }
    case 'find_quote': {
      const text = str(a, 'text');
      const docId = (str(a, 'doc_id', false) || str(a, 'notice_id', false)).trim();
      if (docId) {
        const lib = libraryOf(ctx, docId);
        if (!lib) return { found: false, error: libraryMissing(ctx, docId) };
        return lib.find(docId, text);
      }
      const r = ctx.notice.find(text);
      const multi = ctx.notice.pageCount > 1;
      if (r.found) {
        return { found: true, occurrences: r.occurrences, original: r.text, ...(multi ? { page: r.page } : {}), context: r.context };
      }
      if (r.closest) {
        return {
          found: false,
          closest: r.closest.text,
          ...(multi ? { page: r.closest.page } : {}),
          similarity: r.closest.similarity,
          message: '案例材料中没有这段文字。如需引用，请改用材料中的写法（见 closest），或换一段更短、更准确的片段。',
        };
      }
      return { found: false, message: '案例材料中没有这段文字，也没有相近的片段。' };
    }
    case 'calculate': {
      const expression = str(a, 'expression');
      const vars = (a.variables && typeof a.variables === 'object' ? a.variables : {}) as Record<string, string | number>;
      const { value, substituted } = evaluate(expression, vars);
      const out: Record<string, unknown> = { expression, substituted, exact: toStr(value) };
      if (a.decimals !== undefined && a.decimals !== null && a.decimals !== '') {
        const decimals = Number(a.decimals);
        const mode = (a.rounding ? String(a.rounding) : 'half_up') as Rounding;
        if (!['half_up', 'down', 'up', 'half_even'].includes(mode)) throw new Error(`rounding 只能是 half_up / down / up / half_even`);
        const r = round(value, decimals, mode);
        out.result = toStr(r, decimals);
        out.result_grouped = toGrouped(r, decimals);
        out.decimals = decimals;
        out.rounding = { half_up: '四舍五入', down: '截位（舍去）', up: '进位', half_even: '银行家舍入' }[mode];
      } else {
        out.result = toStr(value);
        out.result_grouped = toGrouped(value);
        out.note = '未指定保留位数，结果未舍入';
      }
      if (a.label) out.label = String(a.label);
      return out;
    }
    case 'trading_day': {
      const op = str(a, 'op');
      const cal = ctx.calendar;
      switch (op) {
        case 'is_trading_day': {
          const d = parseDate(str(a, 'date'));
          const reason = cal.closedReason(d);
          return { date: label(d), is_trading_day: reason === null, reason: reason ?? '交易日' };
        }
        case 'next_trading_day': {
          const d = parseDate(str(a, 'date'));
          const n = cal.nextTradingDay(d);
          return { date: label(d), next_trading_day: label(n) };
        }
        case 'previous_trading_day': {
          const d = parseDate(str(a, 'date'));
          const p = cal.previousTradingDay(d);
          return { date: label(d), previous_trading_day: label(p) };
        }
        case 'add_trading_days': {
          const d = parseDate(str(a, 'date'));
          const n = Number(a.days);
          if (!Number.isInteger(n)) throw new Error('days 必须是整数');
          const r = cal.addTradingDays(d, n);
          return { date: label(d), days: n, result: label(r) };
        }
        case 'acceptance_date': {
          const dt = str(a, 'datetime');
          const cutoff = a.cutoff ? String(a.cutoff) : undefined;
          const r = cal.acceptanceDate(dt, cutoff);
          return { submitted_at: dt, cutoff: cutoff || cal.data.cutoff, acceptance_date: label(r.date), explanation: r.reason };
        }
        default:
          throw new Error(`不支持的 op：${op}`);
      }
    }
    case 'compare': {
      const op = str(a, 'op');
      const lbl = a.label ? { label: String(a.label) } : {};
      if (op === 'number' || op === 'date') {
        const operator = str(a, 'operator');
        const f = OPS[operator];
        if (!f) throw new Error('operator 只能是 > >= < <= ==');
        const leftRaw = str(a, 'left');
        const rightRaw = str(a, 'right');
        let c: number;
        let l: string;
        let r: string;
        if (op === 'number') {
          const ld = dec(leftRaw);
          const rd = dec(rightRaw);
          c = cmp(ld, rd);
          l = toGrouped(ld);
          r = toGrouped(rd);
        } else {
          const ld = parseDate(leftRaw);
          const rd = parseDate(rightRaw);
          c = ld === rd ? 0 : ld > rd ? 1 : -1;
          l = label(ld);
          r = label(rd);
        }
        const result = f(c);
        return { ...lbl, result, explanation: `${l} ${OP_TEXT[operator]} ${r}：${result ? '是' : '否'}` };
      }
      if (op === 'date_in_range') {
        const d = parseDate(str(a, 'date'));
        const s = parseDate(str(a, 'start'));
        const endRaw = a.end === undefined || a.end === null || a.end === '' || a.end === 'null' ? null : String(a.end);
        const e = endRaw ? parseDate(endRaw) : null;
        const incS = a.include_start === undefined ? true : Boolean(a.include_start);
        const incE = a.include_end === undefined ? true : Boolean(a.include_end);
        const afterStart = incS ? d >= s : d > s;
        const beforeEnd = e === null ? true : incE ? d <= e : d < e;
        const result = afterStart && beforeEnd;
        const range = `${label(s)}${incS ? '（含）' : '（不含）'}至${e ? `${label(e)}${incE ? '（含）' : '（不含）'}` : '无结束日（如"另行公告"）'}`;
        return { ...lbl, result, explanation: `${label(d)} ${result ? '在' : '不在'} ${range} 之内` };
      }
      throw new Error(`不支持的 op：${op}`);
    }
    case 'search_notices': {
      if (!ctx.kb) return { error: '本次没有关联公告库。' };
      return ctx.kb.search(a);
    }
    case 'search_rules': {
      if (!ctx.rules) return { error: '本次没有提供规则库。' };
      return ctx.rules.search(a);
    }
    case 'read_document':
    case 'read_notice': {
      const section = typeof a.section === 'string' ? a.section.trim() : '';
      const id = (str(a, 'id', !section).trim() || section.split('#')[0]).trim();
      const lib = libraryOf(ctx, id);
      if (!lib) return { error: libraryMissing(ctx, id) };
      return lib.read(id, a.page_from, a.page_to, section);
    }
    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

/** 工具执行前的异步准备：检索时先把问题转成向量。 */
export async function prepareTool(ctx: ToolContext, name: string, args: Args): Promise<void> {
  if (name === 'search_notices') await ctx.kb?.prepareSearch(args);
  else if (name === 'search_rules') await ctx.rules?.prepareSearch(args);
}

/** 执行一次工具调用，写入调用记录，返回给模型的内容（含编号）。 */
export function executeTool(ctx: ToolContext, agent: AgentRole, round: number, name: string, args: Args): { ref: string; ok: boolean; result: Record<string, unknown> } {
  ctx.counters[agent] += 1;
  const ref = `${agent === 'ops' ? 'T' : 'V'}${ctx.counters[agent]}`;
  let result: Record<string, unknown>;
  let ok = true;
  try {
    result = runTool(ctx, name, args);
    if ('error' in result) ok = false;
  } catch (e) {
    ok = false;
    result = { error: e instanceof Error ? e.message : String(e) };
  }
  const withRef = { ref, ...result };
  ctx.log.push({ ref, agent, round, name, args, result: withRef, ok });
  return { ref, ok, result: withRef };
}
