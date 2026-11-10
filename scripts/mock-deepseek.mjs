// 本地模拟 DeepSeek 的 /chat/completions 接口，用于在 wrangler dev 中端到端测试 Worker。
// 用法：node scripts/mock-deepseek.mjs 9999，然后在 .dev.vars 中设置 DEEPSEEK_BASE_URL=http://localhost:9999
import { createServer } from 'node:http';
import { script, sse } from './mock-script.mjs';

const port = Number(process.argv[2]) || 9999;
createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = JSON.parse(body);
    const auth = req.headers.authorization ?? '';
    const tools = (p.tools ?? []).map((t) => t.function.name);
    const role = tools.includes('submit_review') ? 'review' : 'ops';
    const sys = p.messages[0];
    const problems = [];
    if (!auth.startsWith('Bearer ')) problems.push('缺少 Authorization');
    if (sys?.role !== 'system' || !sys.content.includes('参考资料')) problems.push('缺少系统提示词');
    if (!p.stream) problems.push('没有开启 stream');
    console.log(`[mock-deepseek] ${role} model=${p.model} thinking=${p.thinking?.type} effort=${p.reasoning_effort ?? '-'} msgs=${p.messages.length} ${problems.length ? '问题：' + problems.join('，') : 'ok'}`);
    sse(res, script(role, p.messages.slice(1)));
  });
}).listen(port, () => console.log(`mock deepseek on http://localhost:${port}`));
