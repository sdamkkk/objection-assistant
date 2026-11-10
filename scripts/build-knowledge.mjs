// 把 skills/ 和 knowledge/ 下的文件打包成 src/shared/knowledge.generated.ts，
// 供前端（read_reference 等工具）和服务端（拼接系统提示词）共用。
// 用法：node scripts/build-knowledge.mjs

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function stripFrontMatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

const skills = {
  ops: stripFrontMatter(read('skills/objection-reply/SKILL.md')),
  review: stripFrontMatter(read('skills/objection-review/SKILL.md')),
};

const references = {
  pitfalls: read('knowledge/pitfalls.md'),
  compliance: read('knowledge/compliance.md'),
  'output-formats': read('knowledge/output-formats.md'),
  rules: read('knowledge/rules.md'),
};
for (const dir of ['types', 'segments']) {
  for (const f of readdirSync(join(root, 'knowledge', dir)).filter((f) => f.endsWith('.md')).sort()) {
    references[`${dir}/${f.replace(/\.md$/, '')}`] = read(`knowledge/${dir}/${f}`);
  }
}

const products = JSON.parse(read('knowledge/data/products.json'));
const calendar = JSON.parse(read('knowledge/data/calendar.json'));

const out = `// 此文件由 scripts/build-knowledge.mjs 生成，请勿手工修改。
// 修改 skills/ 或 knowledge/ 下的文件后，运行 npm run knowledge 重新生成。

export const SKILLS: { ops: string; review: string } = ${JSON.stringify(skills, null, 2)};

export const REFERENCES: Record<string, string> = ${JSON.stringify(references, null, 2)};

export const PRODUCTS: { note: string; products: Record<string, unknown>[] } = ${JSON.stringify(products, null, 2)};

export const CALENDAR: { years: number[]; cutoff: string; source: string; holidays: { name: string; start: string; end: string }[] } = ${JSON.stringify(calendar, null, 2)};
`;

mkdirSync(join(root, 'src/shared'), { recursive: true });
writeFileSync(join(root, 'src/shared/knowledge.generated.ts'), out);
console.log(`knowledge: ${Object.keys(references).length} references, ${out.length} chars`);
