// 在命令行里对已部署的站点实跑一个示例案例（引擎和浏览器里的是同一套代码），保存运行记录和结果。
// 用法：node scripts/run-live.ts <站点地址> [示例编号=q1] [输出目录=runs] [应答要求]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../src/core/engine.ts';
import { createHttpModel } from '../src/core/http-model.ts';
import { KnowledgeBase, type KbData } from '../src/core/kb.ts';
import { toRunRecord } from '../src/app/export.ts';
import { SAMPLES, sampleNotice } from '../src/app/samples.ts';
import { applyEvent, type TimelineEntry } from '../src/app/timeline.ts';
import { CALENDAR, PRODUCTS, REFERENCES } from '../src/shared/knowledge.generated.ts';

const [base, id = 'q1', outDir = 'runs', reqArg] = process.argv.slice(2);
if (!base) throw new Error('用法：node scripts/run-live.ts <站点地址> [示例编号] [输出目录] [应答要求]');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = (f: string) => JSON.parse(readFileSync(join(root, 'public/kb/rules', f), 'utf8'));
const date = new Date().toISOString().slice(0, 10);
const notice = sampleNotice(id, date);
const request = reqArg ?? SAMPLES.find((s) => s.id === id)!.requests[0].text;
const data: KbData = { index: kb('index.json'), pages: kb('pages.json'), chunks: kb('chunks.json') };
const cfg = (await (await fetch(`${base}/api/config`)).json()) as { ops: { model: string; thinking: boolean } };

let timeline: TimelineEntry[] = [];
const startedAt = Date.now();
const session = new Session({
  noticeText: notice.text,
  rules: new KnowledgeBase(data, { code: 'rules', asOf: date }),
  callModel: createHttpModel({ endpoint: `${base}/api/agent` }),
  references: REFERENCES,
  products: PRODUCTS.products,
  calendar: CALENDAR,
  onEvent: (e) => {
    timeline = applyEvent(timeline, e);
    if (e.type === 'phase') console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${e.agent} 第 ${e.round} 轮：${e.label}`);
    if (e.type === 'tool') console.log(`   ${e.entry.ref} ${e.entry.name}${e.entry.ok ? '' : '（出错）'}`);
    if (e.type === 'reviewed') console.log(`   检查：必须修改 ${e.review.issues.filter((i) => i.severity === '必须修改').length} 个${e.willRework ? '，退回' : ''}`);
  },
});
let outcome = null;
let error: string | undefined;
try {
  outcome = await session.start(request);
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
  console.error('中断：', error);
}
const state = { id: `run-${startedAt}`, status: outcome ? 'done' : 'error', noticeTitle: notice.label, noticeText: notice.text, requests: [request], timeline, rounds: [...session.rounds], toolLog: [...session.toolLog], outcome, error, startedAt, finishedAt: Date.now() } as const;
mkdirSync(join(root, outDir), { recursive: true });
const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[-:T]/g, '');
writeFileSync(join(root, outDir, `${id}-${stamp}.md`), toRunRecord(state as never, { model: cfg.ops.model, thinking: cfg.ops.thinking }));
writeFileSync(join(root, outDir, `${id}-${stamp}.json`), JSON.stringify({ request, caseText: notice.text, outcome, rounds: session.rounds, toolLog: session.toolLog, timeline }, null, 1));
console.log(`已保存 ${outDir}/${id}-${stamp}.md，状态：${outcome?.status ?? '中断'}`);
