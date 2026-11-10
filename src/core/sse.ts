// 解析 DeepSeek（OpenAI 兼容格式）的流式返回，拼出完整的 assistant 消息。

import type { ModelProgress, ModelReply } from './engine.ts';
import type { ToolCall } from './types.ts';

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}

export class StreamAccumulator {
  content = '';
  reasoning = '';
  finishReason?: string;
  usage?: Record<string, unknown>;
  private calls: { id: string; name: string; args: string }[] = [];

  push(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return;
    const c = chunk as { choices?: { delta?: Delta; finish_reason?: string | null }[]; usage?: Record<string, unknown> };
    if (c.usage) this.usage = c.usage;
    const choice = c.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const d = choice.delta;
    if (!d) return;
    if (d.content) this.content += d.content;
    if (d.reasoning_content) this.reasoning += d.reasoning_content;
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0;
      if (!this.calls[i]) this.calls[i] = { id: '', name: '', args: '' };
      if (tc.id) this.calls[i].id = tc.id;
      if (tc.function?.name) this.calls[i].name += tc.function.name;
      if (tc.function?.arguments) this.calls[i].args += tc.function.arguments;
    }
  }

  progress(): ModelProgress {
    return {
      reasoning: this.reasoning,
      reasoningChars: this.reasoning.length,
      contentChars: this.content.length,
      toolArgsChars: this.calls.reduce((n, c) => n + (c?.args.length ?? 0), 0),
    };
  }

  reply(): ModelReply {
    const tool_calls: ToolCall[] = this.calls
      .filter((c) => c && c.name)
      .map((c, i) => ({ id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args } }));
    return {
      message: {
        role: 'assistant',
        content: this.content,
        ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
        ...(tool_calls.length ? { tool_calls } : {}),
      },
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }
}

/** 逐行解析 SSE 文本流。 */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onData: (json: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      onData(JSON.parse(payload));
    } catch {
      // 忽略无法解析的行（比如心跳注释）
    }
  };
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new Error('已取消');
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) handleLine(buf);
}
