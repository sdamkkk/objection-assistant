// 基于 BigInt 的十进制定点数，避免浮点误差。值 = v / 10^s。

export type Rounding = 'half_up' | 'down' | 'up' | 'half_even';

export interface Dec {
  v: bigint;
  s: number;
}

const TEN = 10n;

function pow10(n: number): bigint {
  if (n < 0) throw new Error('pow10 不接受负数');
  return TEN ** BigInt(n);
}

function normalize(d: Dec): Dec {
  let { v, s } = d;
  while (s > 0 && v % TEN === 0n) {
    v /= TEN;
    s -= 1;
  }
  return { v, s };
}

/** 解析数字。接受 "25,000"、"1.1265"、"-3"、"1e-3"、"0.80%"、"10,000元" 这类写法。 */
export function dec(x: string | number | bigint | Dec): Dec {
  if (typeof x === 'object' && x !== null && 'v' in x) return x;
  if (typeof x === 'bigint') return { v: x, s: 0 };
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new Error(`不是有效数字：${x}`);
    return dec(String(x));
  }
  let str = String(x).trim().replace(/[,，\s]/g, '').replace(/^＋/, '+').replace(/^－/, '-');
  let percent = false;
  if (str.endsWith('%') || str.endsWith('％')) {
    percent = true;
    str = str.slice(0, -1);
  }
  str = str.replace(/(元|份|万元|亿元)$/, (m) => {
    if (m === '万元' || m === '亿元') throw new Error(`请先把"${m}"换算成元：${x}`);
    return '';
  });
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new Error(`不是有效数字：${x}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  let v = BigInt(intPart + fracPart) * sign;
  let s = fracPart.length - exp;
  if (s < 0) {
    v *= pow10(-s);
    s = 0;
  }
  let d = normalize({ v, s });
  if (percent) d = div(d, { v: 100n, s: 0 });
  return d;
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.v * pow10(s - a.s), b.v * pow10(s - b.s), s];
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ v: x + y, s });
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalize({ v: x - y, s });
}

export function mul(a: Dec, b: Dec): Dec {
  return normalize({ v: a.v * b.v, s: a.s + b.s });
}

/** 除法，保留 precision 位小数（截断），供后续再按需舍入。 */
export function div(a: Dec, b: Dec, precision = 30): Dec {
  if (b.v === 0n) throw new Error('除数不能为 0');
  // a/b = a.v*10^b.s / (b.v*10^a.s)
  let num = a.v * pow10(b.s + precision);
  let den = b.v * pow10(a.s);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  return normalize({ v: num / den, s: precision });
}

export function cmp(a: Dec, b: Dec): number {
  const [x, y] = align(a, b);
  return x === y ? 0 : x > y ? 1 : -1;
}

export function round(d: Dec, decimals: number, mode: Rounding = 'half_up'): Dec {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) {
    throw new Error('保留位数应为 0–20 之间的整数');
  }
  if (d.s <= decimals) return d;
  const factor = pow10(d.s - decimals);
  const q = d.v / factor; // 向零截断
  const r = d.v % factor;
  if (r === 0n) return normalize({ v: q, s: decimals });
  const neg = d.v < 0n;
  const absR = neg ? -r : r;
  const twice = absR * 2n;
  let bump = false;
  switch (mode) {
    case 'down':
      bump = false;
      break;
    case 'up':
      bump = true;
      break;
    case 'half_up':
      bump = twice >= factor;
      break;
    case 'half_even': {
      if (twice > factor) bump = true;
      else if (twice < factor) bump = false;
      else bump = (neg ? -q : q) % 2n === 1n;
      break;
    }
  }
  const v = bump ? q + (neg ? -1n : 1n) : q;
  return normalize({ v, s: decimals });
}

/** 输出字符串。fixed 指定时补足小数位。 */
export function toStr(d: Dec, fixed?: number): string {
  let { v, s } = d;
  if (fixed !== undefined && s < fixed) {
    v *= pow10(fixed - s);
    s = fixed;
  }
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString();
  if (s > 0) {
    digits = digits.padStart(s + 1, '0');
    digits = digits.slice(0, digits.length - s) + '.' + digits.slice(digits.length - s);
  }
  return (neg ? '-' : '') + digits;
}

/** 千分位格式，便于阅读。 */
export function toGrouped(d: Dec, fixed?: number): string {
  const str = toStr(d, fixed);
  const [i, f] = str.split('.');
  const neg = i.startsWith('-');
  const body = (neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + body + (f !== undefined ? '.' + f : '');
}
