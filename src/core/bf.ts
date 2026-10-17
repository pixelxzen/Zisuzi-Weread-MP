/** 单号全量归档的逐篇状态模型（Modal 与主逻辑共用） */

export type BfState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface BfItem {
  reviewId: string;
  title: string;
  state: BfState;
  /** 失败原因 / 重试提示 */
  note?: string;
  /** 单篇耗时（毫秒） */
  ms?: number;
  /** 重试次数 */
  tries?: number;
}

export interface BfProgress {
  phase: 'list' | 'fetch';
  done: number;
  total: number;
  written: number;
  /** 翻列表阶段的说明文案 */
  detail?: string;
  items: BfItem[];
}

export interface BfResult {
  written: number;
  skipped: number;
  failed: number;
  stopped: boolean;
  error?: string;
  items: BfItem[];
}
