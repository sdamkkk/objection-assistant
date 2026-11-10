// 把两份 skill 和知识打包成标准的 skill 文件夹，放到 dist-skills/ 下，
// 可以直接复制到 Claude Code 的 .claude/skills/ 目录里试用。
// 用法：node scripts/package-skills.mjs

import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-skills');
rmSync(out, { recursive: true, force: true });

for (const name of ['objection-reply', 'objection-review']) {
  const dir = join(out, name);
  const refs = join(dir, 'references');
  mkdirSync(join(refs, 'types'), { recursive: true });
  mkdirSync(join(refs, 'segments'), { recursive: true });
  mkdirSync(join(refs, 'data'), { recursive: true });
  cpSync(join(root, 'skills', name, 'SKILL.md'), join(dir, 'SKILL.md'));
  for (const f of ['pitfalls.md', 'compliance.md', 'output-formats.md', 'rules.md']) cpSync(join(root, 'knowledge', f), join(refs, f));
  for (const dir of ['types', 'segments']) for (const f of readdirSync(join(root, 'knowledge', dir))) cpSync(join(root, 'knowledge', dir, f), join(refs, dir, f));
  for (const f of readdirSync(join(root, 'knowledge/data'))) cpSync(join(root, 'knowledge/data', f), join(refs, 'data', f));
  cpSync(join(root, 'public/kb/rules/files'), join(refs, 'rules'), { recursive: true });
  cpSync(join(root, 'public/kb/rules/index.json'), join(refs, 'rules', 'index.json'));
  // 由原件转换的 Markdown：在 Claude Code 里可以直接用 grep / Read 检索和阅读
  for (const code of ['rules']) {
    mkdirSync(join(refs, 'markdown', code), { recursive: true });
    for (const f of readdirSync(join(root, 'public/kb', code, 'md')).filter((f) => f.endsWith('.md'))) cpSync(join(root, 'public/kb', code, 'md', f), join(refs, 'markdown', code, f));
  }
}

writeFileSync(
  join(out, 'README.md'),
  `# 在 Claude Code 中试用这两份 skill

1. 把 objection-reply 和 objection-review 两个文件夹复制到项目的 \`.claude/skills/\` 目录（或 \`~/.claude/skills/\`）。
2. 开一个**全新的** Claude Code 会话，把客户原话、已知的产品信息和应答要求交给它，例如：
   "请使用 objection-reply skill 处理这个案例。客户原话：……已知的产品信息：……应答要求：请分别面向高净值客户和普通理财客户输出应答话术。"
3. 得到结果后，再让它使用 objection-review skill 检查上一步的产出。

在 Claude Code 中没有 Demo 里的专用工具，skill 里写了替代做法（用代码计算、在原文中搜索）。规则库的 Markdown 版本在 references/markdown/ 下，可以直接 grep；引用前请对照 references/rules/ 下的原件。
`,
);
console.log(`skills packaged to ${out}`);
