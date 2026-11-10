// 四则运算表达式求值：支持 + - * / ( )、× ÷、百分号、千分位数字和变量名（可用中文）。

import { add, dec, div, mul, sub, toStr, type Dec } from './decimal.ts';

type Tok =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | '%' };

const OP_MAP: Record<string, '+' | '-' | '*' | '/' | '(' | ')' | '%'> = {
  '+': '+', '＋': '+',
  '-': '-', '－': '-', '−': '-',
  '*': '*', '×': '*', '＊': '*',
  '/': '/', '÷': '/', '／': '/',
  '(': '(', '（': '(',
  ')': ')', '）': ')',
  '%': '%', '％': '%',
};

function isIdStart(ch: string): boolean {
  return /[A-Za-z_一-鿿]/.test(ch);
}
function isIdPart(ch: string): boolean {
  return /[A-Za-z0-9_一-鿿]/.test(ch);
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let s = '';
      while (j < src.length) {
        const c = src[j];
        if (/[0-9.]/.test(c)) {
          s += c;
          j++;
        } else if ((c === ',' || c === '，') && /^[0-9]{3}(?![0-9])/.test(src.slice(j + 1))) {
          j++; // 千分位逗号
        } else break;
      }
      if (/[eE]/.test(src[j] ?? '') && /^[eE][+-]?\d/.test(src.slice(j))) {
        const m = /^[eE][+-]?\d+/.exec(src.slice(j))!;
        s += m[0];
        j += m[0].length;
      }
      toks.push({ t: 'num', v: s });
      i = j;
      continue;
    }
    if (isIdStart(ch)) {
      let j = i;
      while (j < src.length && isIdPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OP_MAP[ch];
    if (op) {
      toks.push({ t: 'op', v: op });
      i++;
      continue;
    }
    throw new Error(`表达式中有无法识别的字符："${ch}"`);
  }
  return toks;
}

export interface EvalResult {
  value: Dec;
  substituted: string;
}

export function evaluate(src: string, vars: Record<string, string | number> = {}): EvalResult {
  const toks = tokenize(src);
  if (toks.length === 0) throw new Error('表达式为空');
  let pos = 0;
  const parts: string[] = [];

  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function expr(): Dec {
    let left = term();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      parts.push(` ${op} `);
      const right = term();
      left = op === '+' ? add(left, right) : sub(left, right);
    }
    return left;
  }
  function term(): Dec {
    let left = factor();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v;
      parts.push(op === '*' ? ' × ' : ' ÷ ');
      const right = factor();
      left = op === '*' ? mul(left, right) : div(left, right);
    }
    return left;
  }
  function factor(): Dec {
    const tk = peek();
    if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
      next();
      parts.push(tk.v === '-' ? '-' : '');
      const f = factor();
      return tk.v === '-' ? sub(dec(0), f) : f;
    }
    let val = primary();
    while (peek() && peek().t === 'op' && peek().v === '%') {
      next();
      parts.push('%');
      val = div(val, dec(100));
    }
    return val;
  }
  function primary(): Dec {
    const tk = next();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') {
      parts.push(tk.v);
      return dec(tk.v);
    }
    if (tk.t === 'id') {
      if (!(tk.v in vars)) {
        const known = Object.keys(vars);
        throw new Error(`变量"${tk.v}"没有赋值${known.length ? `（已提供的变量：${known.join('、')}）` : '（请在 variables 中提供）'}`);
      }
      const d = dec(vars[tk.v]);
      parts.push(toStr(d));
      return d;
    }
    if (tk.v === '(') {
      parts.push('(');
      const v = expr();
      const close = next();
      if (!close || close.t !== 'op' || close.v !== ')') throw new Error('括号不匹配');
      parts.push(')');
      return v;
    }
    throw new Error(`表达式在"${tk.v}"附近有误`);
  }

  const value = expr();
  if (pos < toks.length) throw new Error(`表达式在第 ${pos + 1} 个符号附近有多余内容`);
  return { value, substituted: parts.join('').replace(/\s+/g, ' ').trim() };
}
