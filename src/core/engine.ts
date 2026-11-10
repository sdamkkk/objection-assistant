// agent 引擎：模型调用 ⇄ 工具执行的循环，以及"处理 → 检查 → 返工"的编排。

import {
  type LibraryTexts,
  NUDGE_MESSAGE,
  buildFollowUpMessage,
  buildOpsUserMessage,
  buildReviewUserMessage,
  buildReworkMessage,
} from './prompts.ts';
import { SUBMIT_TOOLS, createToolContext, executeTool, prepareTool, type ToolContext, type ToolFeatures } from './tools.ts';
import type { AgentRole, ChatMessage, OpsResult, ReviewIssue, ReviewResult, ToolLogEntry } from './types.ts';
import { validateResult, validateReview, type Validation } from './validate.ts';
import type { CalendarData } from './calendar.ts';
import type { KnowledgeBase } from './kb.ts';

// ---------------------------------------------------------------- 模型调用接口

export interface ModelProgress {
  /** 到目前为止的思考内容（思维链） */
  reasoning?: string;
  reasoningChars: number;
  contentChars: number;
  toolArgsChars: number;
}

export interface ModelReply {
  message: ChatMessage;
  finishReason?: string;
  usage?: Record<string, unknown>;
}

export type CallModel = (
  agent: AgentRole,
  messages: ChatMessage[],
  hooks: {
    onProgress?: (p: ModelProgress) => void;
    signal?: AbortSignal;
    /** 本次可用的额外能力，例如关联了公告库时提供检索工具 */
    features?: ToolFeatures;
  },
) => Promise<ModelReply>;

// ---------------------------------------------------------------- 事件

export type EngineEvent =
  | { type: 'phase'; agent: AgentRole; round: number; label: string }
  | { type: 'model_start'; agent: AgentRole; round: number; step: number }
  | ({ type: 'model_progress'; agent: AgentRole; round: number; step: number } & ModelProgress)
  | { type: 'model_done'; agent: AgentRole; round: number; step: number; text: string; reasoning?: string; toolCalls: string[]; ms: number; usage?: Record<string, unknown> }
  | { type: 'tool'; agent: AgentRole; round: number; entry: ToolLogEntry }
  | { type: 'submit_invalid'; agent: AgentRole; round: number; errors: string[] }
  | { type: 'submitted'; agent: AgentRole; round: number }
  | { type: 'nudge'; agent: AgentRole; round: number; reason: string }
  | { type: 'reviewed'; agent: 'review'; round: number; review: ReviewResult; willRework: boolean }
  | { type: 'review_error'; agent: 'review'; round: number; error: string };

export type EventSink = (e: EngineEvent) => void;

// ---------------------------------------------------------------- 单个 agent 的循环

export class AgentError extends Error {}

function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: '参数必须是 JSON 对象' };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: `参数不是合法的 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function runAgent<T>(o: {
  agent: AgentRole;
  round: number;
  messages: ChatMessage[];
  ctx: ToolContext;
  callModel: CallModel;
  validate: (v: unknown) => Validation<T>;
  maxSteps: number;
  onEvent?: EventSink;
  signal?: AbortSignal;
}): Promise<T> {
  const submitTool = o.agent === 'ops' ? 'submit_result' : 'submit_review';
  const emit = o.onEvent ?? (() => {});
  let nudges = 0;
  for (let step = 1; step <= o.maxSteps; step++) {
    if (o.signal?.aborted) throw new AgentError('已取消');
    emit({ type: 'model_start', agent: o.agent, round: o.round, step });
    const t0 = Date.now();
    const reply = await o.callModel(o.agent, o.messages, {
      signal: o.signal,
      features: { kb: Boolean(o.ctx.kb), rules: Boolean(o.ctx.rules) },
      onProgress: (p) => emit({ type: 'model_progress', agent: o.agent, round: o.round, step, ...p }),
    });
    const msg: ChatMessage = {
      role: 'assistant',
      content: reply.message.content ?? '',
      ...(reply.message.reasoning_content ? { reasoning_content: reply.message.reasoning_content } : {}),
      ...(reply.message.tool_calls?.length ? { tool_calls: reply.message.tool_calls } : {}),
    };
    o.messages.push(msg);
    const calls = msg.tool_calls ?? [];
    emit({
      type: 'model_done',
      agent: o.agent,
      round: o.round,
      step,
      text: msg.content ?? '',
      reasoning: msg.reasoning_content ?? undefined,
      toolCalls: calls.map((c) => c.function.name),
      ms: Date.now() - t0,
      usage: reply.usage,
    });

    if (calls.length === 0) {
      nudges += 1;
      const reason = reply.finishReason === 'length' ? '输出被截断' : '没有调用工具';
      emit({ type: 'nudge', agent: o.agent, round: o.round, reason });
      if (nudges > 3) throw new AgentError(`${o.agent === 'ops' ? '应答' : '检查'} agent 多次没有按要求调用工具提交结果`);
      const extra = reply.finishReason === 'length' ? '你上一条输出被截断了。请精简文字后，' : '';
      o.messages.push({ role: 'user', content: extra + NUDGE_MESSAGE[o.agent] });
      continue;
    }

    let submitted: T | undefined;
    let hasSubmitted = false;
    for (const call of calls) {
      const name = call.function.name;
      const parsed = parseArgs(call.function.arguments);
      let content: Record<string, unknown>;
      if (!parsed.ok) {
        content = { error: parsed.error, message: '请修正参数后重新调用。' };
        if (name === submitTool) emit({ type: 'submit_invalid', agent: o.agent, round: o.round, errors: [parsed.error] });
      } else if (name === submitTool) {
        const v = o.validate(parsed.value);
        if (v.ok) {
          submitted = v.value as T;
          hasSubmitted = true;
          content = { ok: true, message: '已收到。' };
          emit({ type: 'submitted', agent: o.agent, round: o.round });
        } else {
          content = { ok: false, errors: v.errors.slice(0, 40), message: '提交的结构有误，请按 errors 逐条修正后，重新提交完整结果。' };
          emit({ type: 'submit_invalid', agent: o.agent, round: o.round, errors: v.errors });
        }
      } else if (SUBMIT_TOOLS.includes(name)) {
        content = { error: `你不能调用 ${name}，请调用 ${submitTool}` };
      } else {
        await prepareTool(o.ctx, name, parsed.value);
        const r = executeTool(o.ctx, o.agent, o.round, name, parsed.value);
        content = r.result;
        emit({ type: 'tool', agent: o.agent, round: o.round, entry: o.ctx.log[o.ctx.log.length - 1] });
      }
      o.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content) });
    }
    if (hasSubmitted) return submitted as T;
  }
  throw new AgentError(`${o.agent === 'ops' ? '应答' : '检查'} agent 在 ${o.maxSteps} 步内没有提交结果`);
}

// ---------------------------------------------------------------- 处理 → 检查 → 返工

export interface RoundRecord {
  round: number;
  /** 这一轮是怎么来的：首次处理、追问、返工 */
  trigger: 'initial' | 'followup' | 'rework';
  result: OpsResult;
  changedItems: string[];
  review?: ReviewResult;
  reviewError?: string;
}

export type SessionStatus = 'passed' | 'unresolved' | 'review_failed';

export interface SessionOutcome {
  status: SessionStatus;
  result: OpsResult;
  rounds: RoundRecord[];
  /** 最后一次检查中仍未解决的"必须修改"问题 */
  unresolved: ReviewIssue[];
  /** 最后一次检查中的"建议" */
  suggestions: ReviewIssue[];
}

export interface SessionOptions {
  noticeText: string;
  callModel: CallModel;
  references: Record<string, string>;
  products: Record<string, unknown>[];
  calendar: CalendarData;
  /** 当前公告的分页文字（可选；noticeText 应等于各页以空行连接） */
  noticePages?: string[];
  /** 给 agent 阅读的公告版本（按版面还原的 Markdown，表格保留行列）；不提供时用 noticeText */
  noticeView?: string;
  /** 关联的公告库（可选） */
  kb?: KnowledgeBase;
  /** 规则库（可选） */
  rules?: KnowledgeBase;
  maxRework?: number;
  maxSteps?: { ops: number; review: number };
  onEvent?: EventSink;
  signal?: AbortSignal;
}

function itemMap(r: OpsResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of r.sections) for (const it of s.items) m.set(it.id, JSON.stringify(it));
  return m;
}

export function changedItemIds(prev: OpsResult | undefined, next: OpsResult): string[] {
  if (!prev) return [];
  const a = itemMap(prev);
  const out: string[] = [];
  for (const [id, json] of itemMap(next)) if (a.get(id) !== json) out.push(id);
  return out;
}

export class Session {
  readonly opts: SessionOptions;
  readonly ctx: ToolContext;
  readonly opsMessages: ChatMessage[] = [];
  readonly requests: string[] = [];
  readonly rounds: RoundRecord[] = [];
  private roundNo = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.ctx = createToolContext({
      noticeText: opts.noticeText,
      noticePages: opts.noticePages,
      references: opts.references,
      products: opts.products,
      calendar: opts.calendar,
      kb: opts.kb,
      rules: opts.rules,
    });
  }

  /** 给模型的文件库说明 */
  get libraries(): LibraryTexts {
    return { kb: this.opts.kb?.describe(), rules: this.opts.rules?.describe() };
  }

  /** 为下一次运行（如追问）换一个取消信号。 */
  setSignal(signal: AbortSignal | undefined): void {
    this.opts.signal = signal;
  }

  get toolLog(): ToolLogEntry[] {
    return this.ctx.log;
  }

  get latest(): OpsResult | undefined {
    return this.rounds.length ? this.rounds[this.rounds.length - 1].result : undefined;
  }

  async start(request: string): Promise<SessionOutcome> {
    if (this.requests.length) throw new Error('会话已开始，请使用 followUp');
    this.requests.push(request);
    return this.cycle(buildOpsUserMessage(this.opts.noticeView ?? this.opts.noticeText, request, this.libraries, Boolean(this.opts.noticeView)), 'initial');
  }

  async followUp(text: string): Promise<SessionOutcome> {
    if (!this.requests.length) throw new Error('请先调用 start');
    this.requests.push(text);
    return this.cycle(buildFollowUpMessage(text), 'followup');
  }

  private runOps(round: number): Promise<OpsResult> {
    this.opts.onEvent?.({ type: 'phase', agent: 'ops', round, label: round === 1 ? '生成话术' : '修改话术（第 ' + round + ' 轮）' });
    return runAgent<OpsResult>({
      agent: 'ops',
      round,
      messages: this.opsMessages,
      ctx: this.ctx,
      callModel: this.opts.callModel,
      validate: validateResult,
      maxSteps: this.opts.maxSteps?.ops ?? 24,
      onEvent: this.opts.onEvent,
      signal: this.opts.signal,
    });
  }

  private runReview(round: number, result: OpsResult, previousIssues: ReviewIssue[]): Promise<ReviewResult> {
    this.opts.onEvent?.({ type: 'phase', agent: 'review', round, label: '合规检查' });
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: buildReviewUserMessage({
          noticeText: this.opts.noticeView ?? this.opts.noticeText,
          markdown: Boolean(this.opts.noticeView),
          requests: this.requests,
          result,
          toolLog: this.ctx.log,
          previousIssues,
          libs: this.libraries,
        }),
      },
    ];
    return runAgent<ReviewResult>({
      agent: 'review',
      round,
      messages,
      ctx: this.ctx,
      callModel: this.opts.callModel,
      validate: validateReview,
      maxSteps: this.opts.maxSteps?.review ?? 20,
      onEvent: this.opts.onEvent,
      signal: this.opts.signal,
    });
  }

  private async cycle(userMessage: string, trigger: RoundRecord['trigger']): Promise<SessionOutcome> {
    const maxRework = this.opts.maxRework ?? 2;
    this.opsMessages.push({ role: 'user', content: userMessage });
    this.roundNo += 1;
    let prev = this.latest;
    let result = await this.runOps(this.roundNo);
    let record: RoundRecord = { round: this.roundNo, trigger, result, changedItems: changedItemIds(prev, result) };
    this.rounds.push(record);

    let previousIssues: ReviewIssue[] = [];
    let status: SessionStatus = 'passed';
    let lastReview: ReviewResult | undefined;
    for (let rework = 0; ; rework++) {
      try {
        lastReview = await this.runReview(this.roundNo, result, previousIssues);
      } catch (e) {
        if (e instanceof AgentError && e.message === '已取消') throw e;
        record.reviewError = e instanceof Error ? e.message : String(e);
        this.opts.onEvent?.({ type: 'review_error', agent: 'review', round: this.roundNo, error: record.reviewError });
        status = 'review_failed';
        lastReview = undefined;
        break;
      }
      record.review = lastReview;
      const mustFix = lastReview.issues.filter((i) => i.severity === '必须修改');
      const stop = mustFix.length === 0 || rework >= maxRework || mustFix.every((i) => i.repeated);
      this.opts.onEvent?.({ type: 'reviewed', agent: 'review', round: this.roundNo, review: lastReview, willRework: !stop });
      if (mustFix.length === 0) {
        status = 'passed';
        break;
      }
      if (stop) {
        status = 'unresolved';
        break;
      }
      previousIssues = mustFix;
      this.opsMessages.push({ role: 'user', content: buildReworkMessage(mustFix) });
      this.roundNo += 1;
      prev = result;
      result = await this.runOps(this.roundNo);
      record = { round: this.roundNo, trigger: 'rework', result, changedItems: changedItemIds(prev, result) };
      this.rounds.push(record);
    }

    const issues = lastReview?.issues ?? [];
    return {
      status,
      result,
      rounds: [...this.rounds],
      unresolved: status === 'unresolved' ? issues.filter((i) => i.severity === '必须修改') : [],
      suggestions: issues.filter((i) => i.severity === '建议'),
    };
  }
}

// ---------------------------------------------------------------- 单独运行一次检查（用于注入错误的测试）

export async function reviewOnce(opts: {
  noticeText: string;
  requests: string[];
  result: OpsResult;
  toolLog: ToolLogEntry[];
  callModel: CallModel;
  references: Record<string, string>;
  products: Record<string, unknown>[];
  calendar: CalendarData;
  noticePages?: string[];
  noticeView?: string;
  kb?: KnowledgeBase;
  rules?: KnowledgeBase;
  onEvent?: EventSink;
  signal?: AbortSignal;
}): Promise<{ review: ReviewResult; toolLog: ToolLogEntry[] }> {
  const ctx = createToolContext({
    noticeText: opts.noticeText,
    noticePages: opts.noticePages,
    references: opts.references,
    products: opts.products,
    calendar: opts.calendar,
    kb: opts.kb,
    rules: opts.rules,
  });
  ctx.log.push(...opts.toolLog.filter((e) => e.agent === 'ops'));
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: buildReviewUserMessage({
        noticeText: opts.noticeView ?? opts.noticeText,
        markdown: Boolean(opts.noticeView),
        requests: opts.requests,
        result: opts.result,
        toolLog: ctx.log,
        previousIssues: [],
        libs: { kb: opts.kb?.describe(), rules: opts.rules?.describe() },
      }),
    },
  ];
  opts.onEvent?.({ type: 'phase', agent: 'review', round: 1, label: '检查' });
  const review = await runAgent<ReviewResult>({
    agent: 'review',
    round: 1,
    messages,
    ctx,
    callModel: opts.callModel,
    validate: validateReview,
    maxSteps: 20,
    onEvent: opts.onEvent,
    signal: opts.signal,
  });
  return { review, toolLog: ctx.log };
}
