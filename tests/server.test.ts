import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamAccumulator, readSSE } from '../src/core/sse.ts';
import { createHttpModel } from '../src/core/http-model.ts';
import { agentConfig, handleAgent, handleConfig, rateLimited, sanitizeMessages } from '../src/server/agent-handler.ts';

function sseStream(chunks: unknown[], splitAt = 7): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(ctrl) {
      // 故意切成不完整的小块，模拟网络分包
      for (let i = 0; i < bytes.length; i += splitAt) ctrl.enqueue(bytes.slice(i, i + splitAt));
      ctrl.close();
    },
  });
}

const CHUNKS = [
  { choices: [{ delta: { role: 'assistant', reasoning_content: '先算' } }] },
  { choices: [{ delta: { reasoning_content: '金额。' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'calculate', arguments: '{"expre' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ssion":"1+1"}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_product', arguments: '{"name":"稳健增强1号"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
];

test('sse：拼出完整的 assistant 消息（推理、工具调用、用量）', async () => {
  const acc = new StreamAccumulator();
  await readSSE(sseStream(CHUNKS), (c) => acc.push(c));
  const r = acc.reply();
  assert.equal(r.message.reasoning_content, '先算金额。');
  assert.equal(r.message.tool_calls!.length, 2);
  assert.equal(r.message.tool_calls![0].function.arguments, '{"expression":"1+1"}');
  assert.equal(r.message.tool_calls![1].id, 'call_b');
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.usage!.prompt_tokens, 100);
});

test('server：口令、角色、消息校验', async () => {
  const env = { DEEPSEEK_API_KEY: 'k', ACCESS_CODE: 'abc' };
  const noCode = await handleAgent(new Request('http://x/api/agent', { method: 'POST', body: '{}' }), env);
  assert.equal(noCode.status, 401);
  const badRole = await handleAgent(
    new Request('http://x/api/agent', { method: 'POST', headers: { 'x-access-code': 'abc' }, body: JSON.stringify({ role: 'x', messages: [] }) }),
    env,
  );
  assert.equal(badRole.status, 400);
  const noKey = await handleAgent(new Request('http://x/api/agent', { method: 'POST', body: '{}' }), {});
  assert.equal(noKey.status, 500);
  assert.equal(sanitizeMessages([{ role: 'system', content: 'x' }]).ok, false);
  assert.equal(sanitizeMessages([{ role: 'assistant', content: 'x' }]).ok, false);
  const s = sanitizeMessages([{ role: 'user', content: 'hi', extra: 1 }, { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }]);
  assert.equal(s.ok, true);
  if (s.ok) {
    assert.deepEqual(s.messages[0], { role: 'user', content: 'hi' });
    assert.equal(s.messages[1].content, '');
    assert.equal(s.messages[1].reasoning_content, 'r');
  }
});

test('server：拼接系统提示词和工具，转发并回传流', async () => {
  let sent: Record<string, unknown> | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer k');
    sent = JSON.parse(String(init.body));
    return new Response(sseStream(CHUNKS), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const res = await handleAgent(
    new Request('http://x/api/agent', { method: 'POST', body: JSON.stringify({ role: 'review', messages: [{ role: 'user', content: '检查' }] }) }),
    { DEEPSEEK_API_KEY: 'k', REVIEW_THINKING: 'enabled', REVIEW_EFFORT: 'low' },
    fakeFetch,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /event-stream/);
  assert.ok(sent);
  const msgs = sent!.messages as { role: string; content: string }[];
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /独立的合规审核员/);
  assert.match(msgs[0].content, /## 参考资料：易错点说明书/);
  assert.equal(sent!.model, 'deepseek-flash');
  assert.deepEqual(sent!.thinking, { type: 'enabled' });
  assert.equal(sent!.reasoning_effort, 'low');
  const tools = (sent!.tools as { function: { name: string } }[]).map((t) => t.function.name);
  assert.ok(tools.includes('submit_review'));
  assert.ok(!tools.includes('submit_result'));
  // 回传的流能被前端正常解析
  const acc = new StreamAccumulator();
  await readSSE(res.body!, (c) => acc.push(c));
  assert.equal(acc.reply().message.tool_calls!.length, 2);
});

test('server：模型接口出错时返回 502 和原因', async () => {
  const fakeFetch = (async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })) as unknown as typeof fetch;
  const res = await handleAgent(
    new Request('http://x/api/agent', { method: 'POST', body: JSON.stringify({ role: 'ops', messages: [{ role: 'user', content: 'x' }] }) }),
    { DEEPSEEK_API_KEY: 'k' },
    fakeFetch,
  );
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.match(j.error, /402/);
  assert.match(j.detail, /Insufficient Balance/);
});

test('server：配置与限流', async () => {
  assert.equal(agentConfig({ OPS_THINKING: 'disabled' }, 'ops').thinking, false);
  assert.equal(agentConfig({}, 'ops').thinking, true);
  assert.equal(agentConfig({ OPS_EFFORT: 'weird' }, 'ops').effort, 'high');
  const c1 = await handleConfig(new Request('http://x/api/config', { headers: { 'x-access-code': 'no' } }), { ACCESS_CODE: 'abc' }).json();
  assert.equal(c1.requireCode, true);
  assert.equal(c1.codeOk, false);
  const c2 = await handleConfig(new Request('http://x/api/config'), {}).json();
  assert.equal(c2.codeOk, true);
  const key = `test-${Math.random()}`;
  assert.equal(rateLimited(key, 2, 1000), false);
  assert.equal(rateLimited(key, 2, 1001), false);
  assert.equal(rateLimited(key, 2, 1002), true);
  assert.equal(rateLimited(key, 2, 1000 + 11 * 60 * 1000), false);
});

test('http-model：前端解析流，4xx 不重试，5xx 重试一次', async () => {
  let calls = 0;
  const ok = createHttpModel({
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: '模型接口返回 500' }), { status: 502, headers: { 'content-type': 'application/json' } });
      return new Response(sseStream(CHUNKS), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
  const progress: number[] = [];
  const r = await ok('ops', [{ role: 'user', content: 'x' }], { onProgress: (p) => progress.push(p.toolArgsChars) });
  assert.equal(calls, 2);
  assert.equal(r.message.tool_calls!.length, 2);
  assert.ok(progress.length >= 1);

  let denied = 0;
  const bad = createHttpModel({
    fetchImpl: (async () => {
      denied++;
      return new Response(JSON.stringify({ error: '体验口令不正确' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(bad('ops', [{ role: 'user', content: 'x' }], {}), /体验口令不正确/);
  assert.equal(denied, 1);
});

test('/api/embed：转发到 Workers AI，没有绑定时返回 503', async () => {
  const { handleEmbed } = await import('../src/server/embed-handler.ts');
  const req = (body: unknown) => new Request('http://x/api/embed', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `t${Math.random()}` }, body: JSON.stringify(body) });
  const none = await handleEmbed(req({ texts: ['赎回费归谁'] }), {});
  assert.equal(none.status, 503);
  let seen: Record<string, unknown> | undefined;
  const env = { AI: { run: async (model: string, input: Record<string, unknown>) => ((seen = { model, ...input }), { shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) } };
  const ok = await handleEmbed(req({ texts: ['赎回费归谁'] }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { vectors: number[][] }).vectors, [[0.1, 0.2, 0.3]]);
  assert.equal(seen?.model, '@cf/baai/bge-m3');
  assert.equal((await handleEmbed(req({ texts: [] }), env)).status, 400);
  const bad = { AI: { run: async () => ({ nothing: true }) } };
  assert.equal((await handleEmbed(req({ texts: ['x'] }), bad)).status, 502);
});

test('server：界面上的深度思考开关和模型选择', async () => {
  const env = { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-flash' };
  const sent: Record<string, unknown>[] = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(sseStream([{ choices: [{ delta: { content: 'ok' } }] }]), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const call = (extra: Record<string, unknown>) =>
    handleAgent(new Request('http://x/api/agent', { method: 'POST', body: JSON.stringify({ role: 'ops', messages: [{ role: 'user', content: 'hi' }], ...extra }) }), env, fakeFetch);

  const off = await call({ thinking: false, model: 'deepseek-flash' });
  assert.equal(off.status, 200);
  assert.deepEqual(sent.at(-1)!.thinking, { type: 'disabled' });
  assert.equal(sent.at(-1)!.reasoning_effort, undefined);

  const on = await call({ thinking: true });
  assert.equal(on.status, 200);
  assert.deepEqual(sent.at(-1)!.thinking, { type: 'enabled' });

  // 不是布尔值的开关忽略，按服务端默认
  await call({ thinking: 'yes' });
  assert.deepEqual(sent.at(-1)!.thinking, { type: 'enabled' });

  const bad = await call({ model: 'deepseek-pro' });
  assert.equal(bad.status, 400);

  const cfg = await handleConfig(new Request('http://x/api/config'), env).json();
  assert.deepEqual(cfg.models, ['deepseek-flash']);
});
