// 小的共用组件和样式映射。

import type { ReactNode } from 'react';

export const TAG_STYLE: Record<string, string> = {
  案例材料: 'bg-indigo-soft text-indigo',
  披露文件: 'bg-indigo-soft text-indigo ring-1 ring-inset ring-indigo/30',
  产品资料: 'bg-slate-soft text-slate-tag',
  业务规则: 'bg-slate-soft text-slate-tag ring-1 ring-inset ring-rule-strong',
  工具计算: 'bg-teal-soft text-teal',
  AI解读: 'bg-amber-soft text-amber',
  假设: 'bg-amber-soft text-amber ring-1 ring-inset ring-amber/40',
  材料未说明: 'bg-white text-muted ring-1 ring-inset ring-rule-strong',
  需求原话: 'bg-slate-soft text-slate-tag',
};

export const CATEGORY_STYLE: Record<string, string> = {
  材料可直接回答: 'bg-slate-soft text-slate-tag',
  需要计算或判断: 'bg-teal-soft text-teal',
  材料没有说明: 'bg-white text-muted ring-1 ring-inset ring-rule-strong',
  超出边界: 'bg-seal-soft text-seal',
};

export const BASIS_STYLE: Record<string, string> = {
  案例材料: 'bg-slate-soft text-slate-tag',
  假设: 'bg-amber-soft text-amber',
  未提供: 'bg-white text-muted ring-1 ring-inset ring-rule-strong',
};

export function Pill({ className = '', children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-[12px] leading-5 ${className}`}>
      {children}
    </span>
  );
}

export function SectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="text-[15px] font-semibold text-ink">{children}</h3>
      {aside}
    </div>
  );
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function Spinner() {
  return <span aria-hidden className="pulse-dot inline-block h-2 w-2 rounded-full bg-indigo" />;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
