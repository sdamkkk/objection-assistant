import { test } from 'node:test';
import assert from 'node:assert/strict';

import { add, cmp, dec, div, mul, round, sub, toGrouped, toStr } from '../src/core/decimal.ts';
import { evaluate } from '../src/core/expr.ts';
import { TradingCalendar, parseDate, parseDateTime } from '../src/core/calendar.ts';
import { NoticeIndex } from '../src/core/textfind.ts';
import { CALENDAR } from '../src/shared/knowledge.generated.ts';

const cal = new TradingCalendar(CALENDAR);

// ---------------------------------------------------------------- decimal

test('decimal：解析各种写法', () => {
  assert.equal(toStr(dec('25,000')), '25000');
  assert.equal(toStr(dec('10,000元')), '10000');
  assert.equal(toStr(dec('1.1265')), '1.1265');
  assert.equal(toStr(dec('0.80%')), '0.008');
  assert.equal(toStr(dec('-3.50')), '-3.5');
  assert.equal(toStr(dec('1e-3')), '0.001');
  assert.equal(toStr(dec(0.1)), '0.1');
  assert.throws(() => dec('abc'));
  assert.throws(() => dec('5万元'));
});

test('decimal：四则运算没有浮点误差', () => {
  assert.equal(toStr(add(dec('0.1'), dec('0.2'))), '0.3');
  assert.equal(toStr(sub(dec('1.1265'), dec('0.03'))), '1.0965');
  assert.equal(toStr(mul(dec('25000'), dec('0.03'))), '750');
  assert.equal(toStr(round(div(dec('1'), dec('3')), 4, 'half_up')), '0.3333');
  assert.throws(() => div(dec(1), dec(0)));
  assert.equal(cmp(dec('10000'), dec('10,000.00')), 0);
});

test('decimal：舍入方式', () => {
  assert.equal(toStr(round(dec('2.345'), 2, 'half_up')), '2.35');
  assert.equal(toStr(round(dec('2.345'), 2, 'down')), '2.34');
  assert.equal(toStr(round(dec('2.341'), 2, 'up')), '2.35');
  assert.equal(toStr(round(dec('2.345'), 2, 'half_even')), '2.34');
  assert.equal(toStr(round(dec('2.355'), 2, 'half_even')), '2.36');
  assert.equal(toStr(round(dec('-2.345'), 2, 'half_up')), '-2.35');
  assert.equal(toStr(round(dec('-2.349'), 2, 'down')), '-2.34');
  assert.equal(toStr(dec('750'), 2), '750.00');
  assert.equal(toGrouped(dec('1234567.8'), 2), '1,234,567.80');
});

// ---------------------------------------------------------------- expr

test('expr：分红金额、变量、百分号', () => {
  assert.equal(toStr(evaluate('25000 * 0.30 / 10').value), '750');
  assert.equal(toStr(evaluate('份额 × 每10份分红 ÷ 10', { 份额: '25,000', 每10份分红: 0.3 }).value), '750');
  const r = evaluate('50000 / (1 + 0.08%)');
  assert.equal(toStr(round(r.value, 2, 'half_up')), '49960.03');
  assert.equal(toStr(evaluate('-(3 - 5) * 2').value), '4');
  assert.equal(toStr(evaluate('12,345.67 * 0.03').value), '370.3701');
});

test('expr：错误提示', () => {
  assert.throws(() => evaluate('份额 * 2'), /变量"份额"没有赋值/);
  assert.throws(() => evaluate('(1 + 2'), /括号不匹配/);
  assert.throws(() => evaluate('1 + '), /不完整/);
  assert.throws(() => evaluate('1 $ 2'), /无法识别/);
});

// ---------------------------------------------------------------- calendar

test('calendar：日期解析', () => {
  assert.equal(parseDate('2026年6月18日'), '2026-06-18');
  assert.equal(parseDate('2026/6/8'), '2026-06-08');
  assert.deepEqual(parseDateTime('2026年6月17日16:00'), { date: '2026-06-17', time: '16:00' });
  assert.deepEqual(parseDateTime('2026-06-17T9:05'), { date: '2026-06-17', time: '09:05' });
  assert.throws(() => parseDate('2026-02-30'));
});

test('calendar：交易日判断（含节假日和调休周末）', () => {
  assert.equal(cal.isTradingDay('2026-06-17'), true);
  assert.equal(cal.isTradingDay('2026-06-18'), true);
  assert.equal(cal.isTradingDay('2026-06-19'), false); // 端午
  assert.equal(cal.isTradingDay('2026-05-09'), false); // 调休上班的周六，交易所不开市
  assert.equal(cal.isTradingDay('2026-05-08'), true);
  assert.equal(cal.closedReason('2026-10-03'), '国庆节假期');
  assert.equal(cal.nextTradingDay('2026-09-30'), '2026-10-08');
  assert.equal(cal.previousTradingDay('2026-05-06'), '2026-04-30');
  assert.equal(cal.addTradingDays('2026-06-18', 1), '2026-06-22');
  assert.equal(cal.addTradingDays('2026-06-20', 0), '2026-06-22');
  assert.equal(cal.addTradingDays('2026-06-22', -2), '2026-06-17');
  assert.throws(() => cal.isTradingDay('2027-01-04'), /只覆盖 2025、2026/);
});

test('calendar：申请受理日（15:00 截止）', () => {
  assert.equal(cal.acceptanceDate('2026-06-17 16:00').date, '2026-06-18');
  assert.equal(cal.acceptanceDate('2026-06-17 14:59').date, '2026-06-17');
  const at3 = cal.acceptanceDate('2026-06-17 15:00');
  assert.equal(at3.date, '2026-06-18');
  assert.match(at3.reason, /正好是截止时间/);
  assert.equal(cal.acceptanceDate('2026-09-30 20:00').date, '2026-10-08');
  assert.equal(cal.acceptanceDate('2026-06-20 10:00').date, '2026-06-22'); // 周六 + 端午后
  assert.equal(cal.acceptanceDate('2026-11-25 21:00').date, '2026-11-26');
});

// ---------------------------------------------------------------- textfind

const PDF_TEXT = `1. 自2026年5月8日起，本基金管理人将限制接受单日每个基金账户累计申购、定期定额投资和转换
转入本基金超过10,000元的申请，不含10,000元。申购、定期定额投资和转换转入的申请金额合并计
算。
转任本公司其他工作岗位的说明
—`;

test('textfind：忽略换行、千分位和全角半角', () => {
  const idx = new NoticeIndex(PDF_TEXT);
  const r1 = idx.find('定期定额投资和转换转入本基金超过10000元的申请，不含10000元');
  assert.equal(r1.found, true);
  assert.ok(r1.hits[0].text.includes('转换\n转入'));
  assert.equal(idx.find('申请金额合并计算').found, true);
  assert.equal(idx.find('自2026年5月8日起').found, true);
  assert.equal(idx.find('转任本公司其他工作岗位的说明 -').found, true); // 破折号统一
});

test('textfind：找不到时给出最接近的片段', () => {
  const idx = new NoticeIndex(PDF_TEXT);
  const r = idx.find('超过10,000元的申请，含10,000元');
  assert.equal(r.found, false);
  assert.ok(r.closest);
  assert.ok(r.closest!.text.includes('不含'));
  assert.equal(idx.find('完全无关的一句话关于天气').found, false);
});
