// 左栏：案例。客户经理填写客户原话、已知的产品信息和客户情况（或选一个示例），确认后展示案例材料并高亮引用。

import { useState } from 'react';
import { today, type NoticeMeta } from './library.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { SAMPLES, buildCaseText, caseTitle, type CaseInput } from './samples.ts';

export interface NoticeState extends NoticeMeta {
  sampleId?: string;
}

export interface Highlight {
  start: number;
  end: number;
  found: boolean;
  quote: string;
}

export function kbRequestsFor(n: NoticeState | null): { label: string; text: string }[] {
  if (!n) return [];
  return SAMPLES.find((s) => s.id === (n.sampleId ?? 'q1'))?.requests ?? [];
}

const EMPTY: CaseInput = { words: '', facts: '', customer: '', date: today() };

function Field(props: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; rows: number; placeholder: string }) {
  return (
    <div>
      <label htmlFor={props.id} className="mb-1 flex items-baseline gap-2 px-1 text-[14px] font-semibold">
        {props.label}
        {props.hint && <span className="text-[12.5px] font-normal text-muted">{props.hint}</span>}
      </label>
      <textarea id={props.id} className="field doc" rows={props.rows} placeholder={props.placeholder} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  );
}

export function NoticePane(props: {
  notice: NoticeState | null;
  onChange: (n: NoticeState | null) => void;
  highlight: Highlight | null;
  locked: boolean;
  onOpenOriginal?: () => void;
}) {
  const { notice, onChange, highlight, locked } = props;
  const [form, setForm] = useState<CaseInput>(EMPTY);
  const [sampleId, setSampleId] = useState<string | undefined>(undefined);
  const set = (patch: Partial<CaseInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSampleId(undefined);
  };

  if (!notice) {
    const ready = form.words.trim().length >= 4 && form.facts.trim().length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(form.date);
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-[19px] font-semibold tracking-tight">案例</h2>
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="text-muted">示例：</span>
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              className={`rounded-full border px-3 py-0.5 hover:border-indigo hover:text-indigo ${sampleId === s.id ? 'border-indigo bg-indigo-soft text-indigo' : 'border-rule bg-sheet/80 text-ink-soft'}`}
              title={s.origin}
              onClick={() => {
                setForm({ ...s.input, date: form.date || today() });
                setSampleId(s.id);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <Field id="case-words" label="客户原话" value={form.words} onChange={(v) => set({ words: v })} rows={3} placeholder="客户是怎么说的，尽量照原话填" />
        <Field id="case-facts" label="已知的产品信息" hint="数字只会取自这里" value={form.facts} onChange={(v) => set({ facts: v })} rows={5} placeholder="产品名称、类型、是否保本；业绩数据写清指标和区间，例如：近1个月产品回撤1.8%，同类平均回撤2.4%" />
        <Field id="case-customer" label="客户情况" hint="可以不填" value={form.customer} onChange={(v) => set({ customer: v })} rows={2} placeholder="持有金额、买入时间、账户盈亏、风险测评结果、资金用途等" />
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="case-date" className="px-1 text-[14px] font-semibold">
            业务日期
          </label>
          <input id="case-date" type="date" className="field w-auto" value={form.date} onChange={(e) => set({ date: e.target.value })} />
          <span className="text-[12.5px] text-muted">规则库只提供这一天以前发布的规定</span>
        </div>
        <div>
          <button
            className="btn btn-primary"
            disabled={!ready}
            onClick={() => {
              const sample = SAMPLES.find((s) => s.id === sampleId);
              onChange({
                title: caseTitle(form),
                text: buildCaseText(form),
                origin: sample ? `示例案例（${sample.origin}）` : '客户经理填写',
                date: form.date,
                sampleId,
              });
            }}
          >
            使用这个案例
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[16px] font-semibold tracking-tight">案例材料</h2>
        <span className="text-[12.5px] text-muted">{notice.origin}</span>
        <span className="flex-1" />
        <button className="btn text-[13px]" onClick={() => onChange(null)} title={locked ? '正在处理中，返回会停止本次处理' : '回到首页，修改案例或换一个案例'}>
          <span aria-hidden="true">←</span> 修改案例
        </button>
      </div>
      {highlight && !highlight.found && (
        <div className="rounded-xl border border-seal/30 bg-seal-soft px-3 py-2 text-[13px] text-seal">这段引用在案例材料中找不到：“{highlight.quote}”</div>
      )}
      <MarkdownView markdown={notice.markdown} text={notice.text} quote={highlight?.quote} className="sheet max-h-[45vh] min-h-0 overflow-auto px-5 py-4 lg:max-h-none lg:px-8 lg:py-5" />
    </div>
  );
}
