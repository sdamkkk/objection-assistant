// 把 pdf.js 解析中文 PDF 需要的 cmaps 和标准字体复制到 public/pdfjs/，构建时随网站一起发布。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/pdfjs-dist');
const dst = join(root, 'public/pdfjs');
if (!existsSync(src)) {
  console.error('找不到 node_modules/pdfjs-dist，请先运行 npm install');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(src, dir), join(dst, dir), { recursive: true });
console.log('pdf.js assets copied to public/pdfjs');
