import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Session, changedItemIds, type CallModel, type EngineEvent } from '../src/core/engine.ts';
import type { AgentRole, ChatMessage } from '../src/core/types.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../src/shared/knowledge.generated.ts';
import { CASE_TEXT, sampleResult, sampleReview } from './fixtures.ts';

let callSeq = 0;
function toolCall(name: string, args: unknown) {
  callSeq += 1;
  return { id: `call_${callSeq}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}
function assistant(calls: ReturnType<typeof toolCall>[], content = ''): ChatMessage {
  return { role: 'assistant', content, reasoning_content: '思考过程', tool_calls: calls };
}

/** 按角色依次返回预设回复的模拟模型；同时检查每次请求的消息是否合法。 */
function scriptedModel(script: Record<AgentRole, ChatMessage[]>) {
  const seen: Record<AgentRole, ChatMessage[][]> = { ops: [], review: [] };
  const callModel: CallModel = async (agent, messages) => {
    // 合法性：每个 assistant 的 tool_call 后面都必须有对应的 tool 消息
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && m.tool_calls?.length && i < messages.length - 1) {
        const ids = new Set(m.tool_calls.map((c) => c.id));
        for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) ids.delete(messages[j].tool_call_id!);
        assert.equal(ids.size, 0, `tool_call 没有对应的 tool 回复：${[...ids].join(',')}`);
      }
    }
    seen[agent].push(messages.map((m) => ({ ...m })));
    const next = script[agent].shift();
    if (!next) throw new Error(`${agent} 的模拟回复用完了`);
    return { message: next, finishReason: next.tool_calls?.length ? 'tool_calls' : 'stop' };
  };
  return { callModel, seen };
}

function session(callModel: CallModel, events: EngineEvent[] = []) {
  return new Session({
    noticeText: CASE_TEXT,
    callModel,
    references: REFERENCES,
    products: PRODUCTS.products,
    calendar: CALENDAR,
    onEvent: (e) => events.push(e),
  });
}

test('engine：处理 → 检查通过', async () => {
  const { callModel, seen } = scriptedModel({
    ops: [
      assistant([toolCall('read_reference', { name: 'types/业绩回撤与赎回' }), toolCall('get_product', { name: '稳健增强1号' })]),
      assistant([
        toolCall('calculate', { expression: '2.4 - 1.8', decimals: 1 }),
        toolCall('compare', { op: 'number', left: '-0.6', operator: '>', right: '-1.1' }),
      ]),
      assistant([toolCall('submit_result', sampleResult())]),
    ],
    review: [assistant([toolCall('find_quote', { text: '近1个月产品回撤1.8%' })]), assistant([toolCall('submit_review', sampleReview())])],
  });
  const events: EngineEvent[] = [];
  const s = session(callModel, events);
  const out = await s.start('请分别面向高净值客户和普通理财客户输出应答。');
  assert.equal(out.status, 'passed');
  assert.equal(out.rounds.length, 1);
  assert.equal(out.result.sections[0].items[0].text, '近 1 个月产品回撤比同类平均少 0.6 个百分点。');
  // 工具记录：处理 4 次（T1–T4），检查 1 次（V1）
  assert.deepEqual(s.toolLog.map((e) => e.ref), ['T1', 'T2', 'T3', 'T4', 'V1']);
  assert.equal((s.toolLog[2].result as { result: string }).result, '0.6');
  assert.equal((s.toolLog[4].result as { found: boolean }).found, true);
  // 检查 agent 收到的消息里有公告、产出和工具记录，但没有处理环节的推理
  const reviewFirst = seen.review[0][0].content!;
  assert.match(reviewFirst, /【待检查的产出】/);
  assert.match(reviewFirst, /"ref": "T3"/);
  assert.doesNotMatch(reviewFirst, /思考过程/);
  // reasoning_content 会随对话回传
  assert.equal(seen.ops[1][1].reasoning_content, '思考过程');
  assert.ok(events.some((e) => e.type === 'phase' && e.agent === 'review'));
});

test('engine：提交结构不合格时，模型修正后重新提交', async () => {
  const bad = sampleResult();
  bad.sections[0].items[0].sources = [];
  const { callModel, seen } = scriptedModel({
    ops: [assistant([toolCall('submit_result', bad)]), assistant([toolCall('submit_result', sampleResult())])],
    review: [assistant([toolCall('submit_review', sampleReview())])],
  });
  const events: EngineEvent[] = [];
  const out = await session(callModel, events).start('需求');
  assert.equal(out.status, 'passed');
  const toolMsg = seen.ops[1].at(-1)!;
  assert.equal(toolMsg.role, 'tool');
  assert.match(toolMsg.content!, /至少一条 sources/);
  assert.ok(events.some((e) => e.type === 'submit_invalid'));
});

test('engine：没有调用工具时提醒，参数不是 JSON 时报错', async () => {
  const brokenCall = { id: 'call_x', type: 'function' as const, function: { name: 'calculate', arguments: '{expression: 1+1' } };
  const { callModel, seen } = scriptedModel({
    ops: [
      { role: 'assistant', content: '我直接告诉你答案吧' },
      { role: 'assistant', content: '', tool_calls: [brokenCall] },
      assistant([toolCall('submit_result', sampleResult())]),
    ],
    review: [assistant([toolCall('submit_review', sampleReview())])],
  });
  const out = await session(callModel).start('需求');
  assert.equal(out.status, 'passed');
  assert.match(seen.ops[1].at(-1)!.content!, /请不要直接用文字回复/);
  assert.match(seen.ops[2].at(-1)!.content!, /不是合法的 JSON/);
});

test('engine：检查发现问题 → 返工 → 再检查通过', async () => {
  const issue = { id: 'R1', severity: '必须修改', section_id: 'S1', item_id: 'S1-1', problem: '差值错误', basis: 'V1', suggestion: '改为 0.6 个百分点', repeated: false };
  const fixed = sampleResult();
  fixed.sections[0].items[1].text = '是否赎回由客户决定，话术只给判断办法，不劝留也不劝赎。';
  const { callModel, seen } = scriptedModel({
    ops: [assistant([toolCall('submit_result', sampleResult())]), assistant([toolCall('submit_result', fixed)])],
    review: [
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue] as never }))]),
      assistant([toolCall('submit_review', sampleReview())]),
    ],
  });
  const out = await session(callModel).start('需求');
  assert.equal(out.status, 'passed');
  assert.equal(out.rounds.length, 2);
  assert.equal(out.rounds[1].trigger, 'rework');
  assert.deepEqual(out.rounds[1].changedItems, ['S1-2']);
  // 返工消息带着问题清单交回处理 agent
  const reworkMsg = seen.ops[1].filter((m) => m.role === 'user').at(-1)!.content!;
  assert.match(reworkMsg, /【检查环节退回的问题】/);
  assert.match(reworkMsg, /改为 0.6 个百分点/);
  // 第二次检查带着上一轮的问题清单
  assert.match(seen.review[1][0].content!, /【上一轮的问题清单】/);
});

test('engine：最多返工 2 轮，仍有问题则标为未解决', async () => {
  const issue = (repeated: boolean) => ({ id: 'R1', severity: '必须修改', section_id: 'S1', item_id: 'S1-1', problem: '仍然有错', basis: 'x', suggestion: 'y', repeated });
  const suggestion = { id: 'R2', severity: '建议', section_id: 'S3', item_id: '', problem: '可以更简洁', basis: '', suggestion: '精简', repeated: false };
  const { callModel } = scriptedModel({
    ops: [1, 2, 3].map(() => assistant([toolCall('submit_result', sampleResult())])),
    review: [
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue(false)] as never }))]),
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue(false)] as never }))]),
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue(false), suggestion] as never }))]),
    ],
  });
  const out = await session(callModel).start('需求');
  assert.equal(out.status, 'unresolved');
  assert.equal(out.rounds.length, 3);
  assert.equal(out.unresolved.length, 1);
  assert.equal(out.suggestions.length, 1);
});

test('engine：问题都是重复出现的，就不再返工', async () => {
  const issue = (repeated: boolean) => ({ id: 'R1', severity: '必须修改', section_id: 'S1', item_id: 'S1-1', problem: 'p', basis: 'b', suggestion: 's', repeated });
  const { callModel } = scriptedModel({
    ops: [1, 2].map(() => assistant([toolCall('submit_result', sampleResult())])),
    review: [
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue(false)] as never }))]),
      assistant([toolCall('submit_review', sampleReview({ passed: false, issues: [issue(true)] as never }))]),
    ],
  });
  const out = await session(callModel).start('需求');
  assert.equal(out.status, 'unresolved');
  assert.equal(out.rounds.length, 2);
});

test('engine：追问后重新处理并检查', async () => {
  const { callModel, seen } = scriptedModel({
    ops: [assistant([toolCall('submit_result', sampleResult())]), assistant([toolCall('submit_result', sampleResult())])],
    review: [assistant([toolCall('submit_review', sampleReview())]), assistant([toolCall('submit_review', sampleReview())])],
  });
  const s = session(callModel);
  await s.start('第一次需求');
  const out = await s.followUp('客户还说这笔钱明年要用');
  assert.equal(out.status, 'passed');
  assert.equal(out.rounds.at(-1)!.trigger, 'followup');
  assert.match(seen.ops[1].at(-1)!.content!, /【客户经理的追问或补充信息】/);
  assert.match(seen.review[1][0].content!, /（追问 1）客户还说/);
});

test('engine：检查 agent 失败时保留处理结果', async () => {
  const { callModel } = scriptedModel({
    ops: [assistant([toolCall('submit_result', sampleResult())])],
    review: [1, 2, 3, 4].map(() => ({ role: 'assistant' as const, content: '我觉得没问题' })),
  });
  const out = await session(callModel).start('需求');
  assert.equal(out.status, 'review_failed');
  assert.ok(out.rounds[0].reviewError);
  assert.equal(out.result.objection.type, '业绩回撤与赎回');
});

test('engine：changedItemIds', () => {
  const a = sampleResult();
  const b = sampleResult();
  b.sections[2].items[0].answer = '新的回答';
  assert.deepEqual(changedItemIds(a, b), ['S3-1']);
  assert.deepEqual(changedItemIds(undefined, b), []);
});
