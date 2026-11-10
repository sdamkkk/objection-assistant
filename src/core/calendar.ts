// 交易日历：周末休市，法定节假日休市（调休上班的周末也不开市）。

export interface HolidayRange {
  name: string;
  start: string;
  end: string;
}

export interface CalendarData {
  years: number[];
  cutoff: string;
  holidays: HolidayRange[];
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 解析日期：2026-06-18、2026/6/18、2026年6月18日、2026 年 6 月 18 日。返回 YYYY-MM-DD。 */
export function parseDate(input: string): string {
  const s = String(input).replace(/\s+/g, '');
  const m =
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s) ||
    /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new Error(`无法识别的日期："${input}"，请使用 YYYY-MM-DD 格式`);
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`日期不存在："${input}"`);
  }
  return fmt(dt);
}

/** 解析日期时间：2026-06-17 16:00、2026年6月17日16:00、2026-06-17T16:00。 */
export function parseDateTime(input: string): { date: string; time: string } {
  const s = String(input).trim().replace('T', ' ');
  const m = /^(.+?)\s*(\d{1,2})[:：](\d{2})(?:[:：]\d{2})?$/.exec(s);
  if (!m) throw new Error(`无法识别的日期时间："${input}"，请使用 "YYYY-MM-DD HH:mm" 格式`);
  const date = parseDate(m[1].trim());
  const hh = +m[2];
  const mm = +m[3];
  if (hh > 23 || mm > 59) throw new Error(`时间不存在："${input}"`);
  return { date, time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

function fmt(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shift(iso: string, days: number): string {
  const dt = toDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fmt(dt);
}

export function weekday(iso: string): string {
  return WEEKDAYS[toDate(iso).getUTCDay()];
}

/** 展示用：2026-06-18（周四） */
export function label(iso: string): string {
  return `${iso}（${weekday(iso)}）`;
}

export class TradingCalendar {
  readonly data: CalendarData;

  constructor(data: CalendarData) {
    this.data = data;
  }

  private ensureCovered(iso: string): void {
    const y = +iso.slice(0, 4);
    if (!this.data.years.includes(y)) {
      throw new Error(`交易日历只覆盖 ${this.data.years.join('、')} 年，无法判断 ${iso}`);
    }
  }

  holidayOf(iso: string): HolidayRange | undefined {
    return this.data.holidays.find((h) => iso >= h.start && iso <= h.end);
  }

  /** 非交易日的原因；是交易日时返回 null。 */
  closedReason(iso: string): string | null {
    this.ensureCovered(iso);
    const h = this.holidayOf(iso);
    if (h) return `${h.name}假期`;
    const wd = toDate(iso).getUTCDay();
    if (wd === 0 || wd === 6) return '周末';
    return null;
  }

  isTradingDay(iso: string): boolean {
    return this.closedReason(iso) === null;
  }

  nextTradingDay(iso: string): string {
    let d = shift(iso, 1);
    for (let i = 0; i < 40; i++) {
      if (this.isTradingDay(d)) return d;
      d = shift(d, 1);
    }
    throw new Error(`在 ${iso} 之后 40 天内找不到交易日`);
  }

  previousTradingDay(iso: string): string {
    let d = shift(iso, -1);
    for (let i = 0; i < 40; i++) {
      if (this.isTradingDay(d)) return d;
      d = shift(d, -1);
    }
    throw new Error(`在 ${iso} 之前 40 天内找不到交易日`);
  }

  /**
   * 从 iso 起移动 n 个交易日：n>0 为其后第 n 个交易日，n<0 为其前第 |n| 个交易日；
   * n=0 时，iso 是交易日则返回 iso，否则返回下一个交易日。
   */
  addTradingDays(iso: string, n: number): string {
    if (!Number.isInteger(n)) throw new Error('days 必须是整数');
    if (n === 0) return this.isTradingDay(iso) ? iso : this.nextTradingDay(iso);
    let d = iso;
    for (let i = 0; i < Math.abs(n); i++) {
      d = n > 0 ? this.nextTradingDay(d) : this.previousTradingDay(d);
    }
    return d;
  }

  /** 申请受理日：交易日截止时间前提交的按当日受理，否则按下一个交易日受理。 */
  acceptanceDate(dateTime: string, cutoff?: string): { date: string; reason: string } {
    const { date, time } = parseDateTime(dateTime);
    const cut = cutoff || this.data.cutoff;
    const closed = this.closedReason(date);
    if (closed) {
      const n = this.nextTradingDay(date);
      return { date: n, reason: `${label(date)}是非交易日（${closed}），申请顺延到下一个交易日 ${label(n)} 受理` };
    }
    if (time < cut) {
      return { date, reason: `${label(date)}是交易日，${time} 早于 ${cut} 截止时间，按当日受理` };
    }
    const n = this.nextTradingDay(date);
    const at = time === cut ? `${time} 正好是截止时间，按截止后处理（以销售渠道规则为准）` : `${time} 已过 ${cut} 截止时间`;
    return { date: n, reason: `${label(date)}是交易日，但 ${at}，按下一个交易日 ${label(n)} 受理` };
  }
}
