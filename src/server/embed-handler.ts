// /api/embed：把检索问题转成向量（Cloudflare Workers AI 的 bge-m3），供浏览器里的向量检索使用。
// 文件库各段落的向量是构建时用同一个模型（BAAI/bge-m3）预先算好的，随网站发布（public/kb/<库>/embeddings.*）。
// 没有绑定 Workers AI 时返回 503，浏览器自动退回只用 BM25。

import { checkAccess, rateLimited, type Env } from './agent-handler.ts';

export const EMBED_MODEL = '@cf/baai/bge-m3';

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface EmbedEnv extends Env {
  AI?: AiBinding;
}

const MAX_TEXTS = 4;
const MAX_CHARS = 600;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Workers AI 的返回：{ shape, data: number[][] }（个别版本放在 response 里）。 */
export function vectorsOf(out: unknown): number[][] | undefined {
  const o = out as { data?: unknown; response?: unknown };
  const v = Array.isArray(o?.data) ? o.data : Array.isArray(o?.response) ? o.response : undefined;
  if (!v || !v.every((x) => Array.isArray(x) && x.every((n) => typeof n === 'number'))) return undefined;
  return v as number[][];
}

export async function handleEmbed(request: Request, env: EmbedEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  const denied = checkAccess(request, env);
  if (denied) return denied;
  if (!env.AI) return json({ error: '服务端没有绑定 Workers AI，向量检索不可用' }, 503);
  const key = `embed:${request.headers.get('x-access-code') || request.headers.get('cf-connecting-ip') || 'anon'}`;
  if (rateLimited(key, Number(env.RATE_LIMIT_PER_10MIN) || 400)) return json({ error: '请求过于频繁，请稍后再试' }, 429);
  let body: { texts?: unknown };
  try {
    body = (await request.json()) as { texts?: unknown };
  } catch {
    return json({ error: '请求格式不对' }, 400);
  }
  const texts = Array.isArray(body.texts) ? body.texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
  if (!texts.length || texts.length > MAX_TEXTS) return json({ error: `texts 需要 1–${MAX_TEXTS} 条文字` }, 400);
  try {
    const out = await env.AI.run(EMBED_MODEL, { text: texts.map((t) => t.slice(0, MAX_CHARS)) });
    const vectors = vectorsOf(out);
    if (!vectors || vectors.length !== texts.length) return json({ error: '向量服务返回的格式不对' }, 502);
    return json({ model: EMBED_MODEL, vectors });
  } catch (e) {
    return json({ error: `向量服务出错：${e instanceof Error ? e.message : String(e)}` }, 502);
  }
}
