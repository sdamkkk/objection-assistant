// 输入框：文字区域 + 底部一排按钮（深度思考开关、模型选择、发送/停止），样式参照常见的对话输入框。

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function modelLabel(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w === 'deepseek' ? 'DeepSeek' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function AtomIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <ellipse cx="8" cy="8" rx="6.3" ry="2.6" />
      <ellipse cx="8" cy="8" rx="6.3" ry="2.6" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.3" ry="2.6" transform="rotate(120 8 8)" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2" strokeLinecap="round" />
    </svg>
  );
}

const chip = (active: boolean) =>
  `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
    active ? 'border-indigo/35 bg-indigo-soft text-indigo' : 'border-rule-strong bg-sheet/70 text-ink-soft hover:border-indigo/40 hover:text-indigo'
  }`;

function ModelPicker({ model, models, onChange, disabled }: { model: string; models: string[]; onChange: (m: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={chip(false)} onClick={() => setOpen((v) => !v)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} title="选择模型">
        <ChipIcon />
        {modelLabel(model)}
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" className="absolute bottom-full left-0 z-20 mb-2 w-56 overflow-hidden rounded-2xl border border-rule bg-sheet py-1 shadow-[0_18px_40px_-16px_rgba(45,70,160,0.45)]">
          {models.map((m) => (
            <li key={m}>
              <button
                type="button"
                role="option"
                aria-selected={m === model}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-indigo-soft/60"
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <span className="flex-1">{modelLabel(m)}</span>
                {m === model && (
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="text-indigo">
                    <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Composer(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 文字不能改（已经开始处理） */
  locked?: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  running?: boolean;
  onStop?: () => void;
  submitLabel: string;
  thinking: boolean;
  onThinking: (v: boolean) => void;
  model: string;
  models: string[];
  onModel: (m: string) => void;
  /** 发送按钮左边的提示文字 */
  hint?: ReactNode;
  /** 替换发送按钮的内容（例如"处理新的需求"） */
  action?: ReactNode;
  minHeight?: number;
}) {
  const { locked, running } = props;
  return (
    <div className="rounded-[24px] border border-rule-strong/70 bg-sheet/85 shadow-[0_10px_30px_-20px_rgba(45,70,160,0.5)] transition-shadow focus-within:border-indigo/40 focus-within:shadow-[0_0_0_4px_rgba(77,107,254,0.08),0_10px_30px_-20px_rgba(45,70,160,0.5)]">
      <textarea
        id={props.id}
        className="block w-full resize-none rounded-t-[24px] bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-relaxed outline-none placeholder:text-muted disabled:text-ink-soft"
        style={{ minHeight: props.minHeight ?? 96 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={locked}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && props.canSubmit) props.onSubmit();
        }}
      />
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        <button
          type="button"
          className={chip(props.thinking)}
          aria-pressed={props.thinking}
          disabled={locked}
          onClick={() => props.onThinking(!props.thinking)}
          title={props.thinking ? '已开启深度思考：模型先推理再回答，更慢但更稳' : '已关闭深度思考：更快，适合简单问题'}
        >
          <AtomIcon />
          深度思考
        </button>
        <ModelPicker model={props.model} models={props.models} onChange={props.onModel} disabled={locked} />
        <span className="min-w-0 flex-1 truncate px-1 text-right text-[12.5px] text-muted">{props.hint}</span>
        {props.action ??
          (running ? (
            <button type="button" aria-label="停止" title="停止" onClick={props.onStop} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-ink-soft">
              <span className="h-3 w-3 rounded-[3px] bg-white" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={props.submitLabel}
              title={props.submitLabel}
              disabled={!props.canSubmit}
              onClick={props.onSubmit}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo text-white shadow-[0_6px_16px_-8px_rgba(77,107,254,0.9)] transition-colors hover:bg-[#3d5bf0] disabled:cursor-not-allowed disabled:bg-indigo/35 disabled:shadow-none"
            >
              <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
      </div>
    </div>
  );
}
