// 浏览器端的模型调用：把对话发给 /api/agent，读取流式返回。

import type { CallModel } from './engine.ts';
import { StreamAccumulator, readSSE } from './sse.ts';

export class ModelHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createHttpModel(opts: {
  endpoint?: string;
  getAccessCode?: () => string;
  fetchImpl?: typeof fetch;
  /** 网络错误或 5xx 时的重试次数 */
  retries?: number;
  /** 用户在界面上选的模型和深度思考开关 */
  getOptions?: () => { thinking?: boolean; model?: string };
}): CallModel {
  const endpoint = opts.endpoint ?? '/api/agent';
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const retries = opts.retries ?? 1;

  return async (agent, messages, hooks) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-access-code': opts.getAccessCode?.() ?? '' },
          body: JSON.stringify({ role: agent, messages, ...(hooks.features?.kb ? { kb: true } : {}), ...(hooks.features?.rules ? { rules: true } : {}), ...(opts.getOptions?.() ?? {}) }),
          signal: hooks.signal,
        });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.includes('text/event-stream') || !res.body) {
          let msg = `接口返回 ${res.status}`;
          try {
            const j = await res.json();
            msg = [j.error, j.detail].filter(Boolean).join('：') || msg;
          } catch {
            /* 非 JSON */
          }
          throw new ModelHttpError(msg, res.status);
        }
        const acc = new StreamAccumulator();
        let last = 0;
        await readSSE(
          res.body,
          (chunk) => {
            acc.push(chunk);
            const now = Date.now();
            if (now - last > 200) {
              last = now;
              hooks.onProgress?.(acc.progress());
            }
          },
          hooks.signal,
        );
        hooks.onProgress?.(acc.progress());
        const reply = acc.reply();
        if (!reply.message.content && !reply.message.tool_calls?.length) {
          throw new ModelHttpError('模型返回了空内容', 502);
        }
        return reply;
      } catch (e) {
        lastErr = e;
        if (hooks.signal?.aborted) throw e;
        // 4xx（口令错误、请求不合法、限流）不重试
        if (e instanceof ModelHttpError && e.status >= 400 && e.status < 500) throw e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    throw lastErr;
  };
}
