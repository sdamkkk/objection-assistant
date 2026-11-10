// 共用类型定义。

export type AgentRole = 'ops' | 'review';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string | null;
}

export interface ToolLogEntry {
  ref: string;
  agent: AgentRole;
  round: number;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

export const SOURCE_TAGS = ['案例材料', '披露文件', '法规原文', '产品资料', '业务规则', '工具计算', 'AI解读', '材料未说明', '需求原话', '假设'] as const;
export type SourceTag = (typeof SOURCE_TAGS)[number];

export const AUDIENCES = ['客户经理', '高净值客户（话术）', '普通理财客户（话术）', '通用'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const KINDS = ['list', 'qa', 'table', 'steps', 'draft'] as const;
export type Kind = (typeof KINDS)[number];

export const QUESTION_CATEGORIES = ['材料可直接回答', '需要计算或判断', '材料没有说明', '超出边界'] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const SITUATION_BASIS = ['案例材料', '假设', '未提供'] as const;

export interface Source {
  tag: SourceTag;
  quote?: string;
  /** 披露文件、法规原文：文件编号 */
  doc?: string;
  ref?: string;
  note?: string;
}

export interface Item {
  id: string;
  text?: string;
  question?: string;
  answer?: string;
  forbidden?: string[];
  escalate?: string;
  cells?: string[];
  sources: Source[];
}

export interface Section {
  id: string;
  title: string;
  audience: Audience;
  kind: Kind;
  columns?: string[];
  items: Item[];
}

export interface OpsResult {
  task: {
    deliverables: string[];
    user_situation: { item: string; value: string; basis: (typeof SITUATION_BASIS)[number] }[];
    questions: { id: string; text: string; category: QuestionCategory }[];
  };
  /** 客户异议的类型、标题和一句话概括 */
  objection: { type: string; title: string; summary: string };
  sections: Section[];
}

export const SEVERITIES = ['必须修改', '建议'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ReviewIssue {
  id: string;
  severity: Severity;
  section_id: string;
  item_id: string;
  problem: string;
  basis: string;
  suggestion: string;
  repeated: boolean;
}

export interface ReviewResult {
  passed: boolean;
  summary: string;
  checks: { item: string; result: string; refs?: string }[];
  issues: ReviewIssue[];
}
