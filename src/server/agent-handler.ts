// /api/agent 的处理逻辑：校验口令和请求、拼接系统提示词、转发给 DeepSeek 并原样回传流式结果。
// 放在 src/server 下，便于在 Node 中测试；src/worker.ts 负责路由。

import { buildSystemPrompt } from '../core/prompts.ts';
import { toolDefs, type ToolFeatures } from '../core/tools.ts';
import type { AgentRole } from '../core/types.ts';
import { REFERENCES, SKILLS } from '../shared/knowledge.generated.ts';

export interface Env {
  DEEPSEEK_API_KEY?: string;
  ACCESS_CODE?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_MODEL?: string;
  OPS_THINKING?: string;
  REVIEW_THINKING?: string;
  OPS_EFFORT?: string;
  REVIEW_EFFORT?: string;
  MAX_TOKENS?: string;
  RATE_LIMIT_PER_10MIN?: string;
}

export interface AgentConfig {
  model: string;
  thinking: boolean;
  effort: string;
  maxTokens: number;
}

export function agentConfig(env: Env, role: AgentRole): AgentConfig {
  const thinkingRaw = (role === 'ops' ? env.OPS_THINKING : env.REVIEW_THINKING) ?? 'enabled';
  const effort = (role === 'ops' ? env.OPS_EFFORT : env.REVIEW_EFFORT) ?? 'high';
  return {
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    thinking: thinkingRaw !== 'disabled',
    effort: ['low', 'high', 'max'].includes(effort) ? effort : 'high',
    maxTokens: Math.min(Math.max(Number(env.MAX_TOKENS) || 65536, 2048), 131072),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkAccess(request: Request, env: Env): Response | null {
  if (!env.ACCESS_CODE) return null;
  const code = request.headers.get('x-access-code') ?? '';
  if (!safeEqual(code, env.ACCESS_CODE)) return json({ error: '体验口令不正确' }, 401);
  return null;
}

// 尽力而为的限流：同一个运行实例内有效（Cloudflare 可能有多个实例）。
const hits = new Map<string, number[]>();
export function rateLimited(key: string, limit: number, now = Date.now()): boolean {
  const windowMs = 10 * 60 * 1000;
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  return false;
}

const MAX_BODY_CHARS = 2_000_000;

type InMsg = Record<string, unknown>;

export function sanitizeMessages(raw: unknown): { ok: true; messages: InMsg[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'messages 不能为空' };
  if (raw.length > 240) return { ok: false, error: '对话过长' };
  const out: InMsg[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'messages 格式错误' };
    const msg = m as InMsg;
    const role = msg.role;
    if (role === 'user') {
      if (typeof msg.content !== 'string') return { ok: false, error: 'user 消息需要 content' };
      out.push({ role, content: msg.content });
    } else if (role === 'assistant') {
      const o: InMsg = { role, content: typeof msg.content === 'string' ? msg.content : '' };
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) o.reasoning_content = msg.reasoning_content;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        o.tool_calls = msg.tool_calls.map((c) => {
          const tc = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          return {
            id: String(tc.id ?? ''),
            type: 'function',
            function: { name: String(tc.function?.name ?? ''), arguments: String(tc.function?.arguments ?? '') },
          };
        });
      }
      out.push(o);
    } else if (role === 'tool') {
      if (typeof msg.tool_call_id !== 'string' || typeof msg.content !== 'string') return { ok: false, error: 'tool 消息需要 tool_call_id 和 content' };
      out.push({ role, tool_call_id: msg.tool_call_id, content: msg.content });
    } else {
      return { ok: false, error: `不支持的消息角色：${String(role)}` };
    }
  }
  if (out[0].role !== 'user') return { ok: false, error: '第一条消息必须是 user' };
  return { ok: true, messages: out };
}

export function buildPayload(role: AgentRole, messages: InMsg[], cfg: AgentConfig, features: ToolFeatures = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'system', content: buildSystemPrompt(role, SKILLS, REFERENCES) }, ...messages],
    tools: toolDefs(role, Object.keys(REFERENCES), { kb: features.kb === true, rules: features.rules === true }),
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: cfg.maxTokens,
    thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
  };
  if (cfg.thinking) payload.reasoning_effort = cfg.effort;
  else payload.temperature = 0.3;
  return payload;
}

export async function handleAgent(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  const denied = checkAccess(request, env);
  if (denied) return denied;
  if (!env.DEEPSEEK_API_KEY) return json({ error: '服务端没有配置 DEEPSEEK_API_KEY' }, 500);

  const key = request.headers.get('x-access-code') || request.headers.get('cf-connecting-ip') || 'anon';
  const limit = Number(env.RATE_LIMIT_PER_10MIN) || 400;
  if (rateLimited(key, limit)) return json({ error: '请求过于频繁，请稍后再试' }, 429);

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return json({ error: '请求内容过大' }, 413);
  let body: { role?: unknown; messages?: unknown; kb?: unknown; rules?: unknown; thinking?: unknown; model?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: '请求不是合法的 JSON' }, 400);
  }
  const role = body.role;
  if (role !== 'ops' && role !== 'review') return json({ error: 'role 只能是 ops 或 review' }, 400);
  const sanitized = sanitizeMessages(body.messages);
  if (!sanitized.ok) return json({ error: sanitized.error }, 400);

  const cfg = { ...agentConfig(env, role) };
  // 前端的"深度思考"开关：只接受布尔值；模型只能选服务端允许的（目前只有一个）
  if (typeof body.thinking === 'boolean') cfg.thinking = body.thinking;
  if (body.model !== undefined && body.model !== cfg.model) return json({ error: `不支持的模型：${String(body.model)}` }, 400);
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(role, sanitized.messages, cfg, { kb: body.kb === true, rules: body.rules === true })),
    });
  } catch (e) {
    return json({ error: '无法连接模型接口', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: `模型接口返回 ${upstream.status}`, detail: detail.slice(0, 2000) }, 502);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-model': cfg.model,
      'x-thinking': cfg.thinking ? cfg.effort : 'disabled',
    },
  });
}

export function handleConfig(request: Request, env: Env): Response {
  const base = {
    requireCode: Boolean(env.ACCESS_CODE),
    hasKey: Boolean(env.DEEPSEEK_API_KEY),
    ops: agentConfig(env, 'ops'),
    review: agentConfig(env, 'review'),
    models: [agentConfig(env, 'ops').model],
  };
  if (!env.ACCESS_CODE) return json({ ...base, codeOk: true });
  const code = request.headers.get('x-access-code') ?? '';
  return json({ ...base, codeOk: safeEqual(code, env.ACCESS_CODE) });
}
