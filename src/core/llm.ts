/**
 * LLM 路由：统一走 OpenAI 兼容协议（chat/completions）
 * 默认 DeepSeek；可切智谱/Kimi/OpenAI/OpenRouter/Ollama/自定义。
 * 只用注入的 http（Obsidian requestUrl），不打包任何厂商 SDK。
 */

import { parseJson, pickArr, pickNum, pickObj, pickStr } from './typed';
export type ProviderId = 'deepseek' | 'zhipu' | 'kimi' | 'openai' | 'openrouter' | 'ollama' | 'custom';

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  note: string;
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    label: 'DeepSeek（默认）',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    note: '中文长文质量好、价格低；摘要约 ¥0.01/篇',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    note: '免费额度较多',
  },
  kimi: {
    label: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsKey: true,
    note: '长上下文友好',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    note: '需要海外网络',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    needsKey: true,
    note: '一个 key 通吃多模型',
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    note: '完全本地，数据不出机器',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    needsKey: false,
    note: '任何兼容 /chat/completions 的端点',
  },
};

export interface LLMSettings {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  dailyCallLimit: number;
  autoSummarize: boolean;
  autoTranslate: boolean;
}

export const LLM_DEFAULTS: LLMSettings = {
  provider: 'deepseek',
  baseUrl: PROVIDERS.deepseek.baseUrl,
  apiKey: '',
  model: PROVIDERS.deepseek.model,
  temperature: 0.3,
  maxTokens: 800,
  dailyCallLimit: 100,
  autoSummarize: false,
  autoTranslate: false,
};

export interface HttpRespLike {
  status: number;
  text: string;
}

export type HttpFn = (url: string, headers: Record<string, string>, method: string, body?: string) => Promise<HttpRespLike>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

/** 粗略 token 估算：中文约 1.5 字/token，英文约 4 字符/token */
export function estimateTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

export function endpointOf(cfg: LLMSettings): string {
  const base = (cfg.baseUrl || PROVIDERS[cfg.provider]?.baseUrl || '').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export class LLMError extends Error {
  constructor(public kind: 'config' | 'quota' | 'auth' | 'network' | 'api', message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

export function validateConfig(cfg: LLMSettings): string | null {
  if (!cfg.baseUrl) return '未填 Base URL';
  if (!cfg.model) return '未填模型名';
  const preset = PROVIDERS[cfg.provider];
  if (preset?.needsKey && !cfg.apiKey) return `该服务需要 API Key（${preset.label}）`;
  return null;
}

export interface QuotaState {
  day: string;   // YYYY-MM-DD
  count: number;
}

export function quotaToday(q: QuotaState | undefined, today: string): QuotaState {
  if (!q || q.day !== today) return { day: today, count: 0 };
  return q;
}

export function checkQuota(cfg: LLMSettings, q: QuotaState): void {
  if (q.count >= cfg.dailyCallLimit) {
    throw new LLMError('quota', `今日调用已达上限 ${cfg.dailyCallLimit} 次（设置里可调）`);
  }
}

/** 一次 chat completion */
export async function chat(
  http: HttpFn,
  cfg: LLMSettings,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<ChatResult> {
  const bad = validateConfig(cfg);
  if (bad) throw new LLMError('config', bad);

  const url = endpointOf(cfg);
  if (!/^https?:\/\//.test(url)) throw new LLMError('config', `Base URL 不合法：${cfg.baseUrl}`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: false,
  });

  let resp: HttpRespLike;
  try {
    resp = await http(url, headers, 'POST', body);
  } catch (e) {
    throw new LLMError('network', `请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (resp.status === 401 || resp.status === 403) throw new LLMError('auth', `鉴权失败 HTTP ${resp.status}（检查 API Key）`);
  if (resp.status === 429) throw new LLMError('quota', '触发服务端限流 HTTP 429');
  if (resp.status >= 400) {
    throw new LLMError('api', `HTTP ${resp.status}：${resp.text.slice(0, 200)}`);
  }

  const json = parseJson(resp.text);
  if (json === null) throw new LLMError('api', '返回非 JSON（可能是网关/代理页面）');
  const choice = pickObj(pickArr(json, 'choices')[0], 'message');
  const text = pickStr(choice, 'content');
  if (!text.trim()) throw new LLMError('api', '模型返回空内容');

  const usage = pickObj(json, 'usage');
  return {
    text: text.trim(),
    model: pickStr(json, 'model') || cfg.model,
    promptTokens: pickNum(usage, 'prompt_tokens'),
    completionTokens: pickNum(usage, 'completion_tokens'),
  };
}

/** 测试连接：极短 prompt，返回模型名与延迟 */
export async function testConnection(http: HttpFn, cfg: LLMSettings): Promise<string> {
  const t0 = Date.now();
  const r = await chat(http, cfg, [{ role: 'user', content: '只回复两个字：在线' }], { maxTokens: 16 });
  const ms = Date.now() - t0;
  return `${r.model} 在线（${ms}ms）：${r.text.slice(0, 20)}`;
}

const SUMMARY_SYSTEM = `你是中文技术文章编辑。用 3-5 条要点总结文章，每条一行、以「- 」开头，不超过 200 字。
只输出要点，不要复述原文，不要加"总结："之类的前缀，不要编造文中没有的事实。`;

export async function summarize(http: HttpFn, cfg: LLMSettings, title: string, markdown: string): Promise<string> {
  // 控制输入：超长截断，避免成本失控（保留头尾）
  const hardCap = 24000;
  const bodyText = markdown.length > hardCap
    ? markdown.slice(0, hardCap * 0.7) + '\n\n…（中间省略）…\n\n' + markdown.slice(-hardCap * 0.3)
    : markdown;
  const r = await chat(http, cfg, [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: `标题：${title}\n\n正文：\n${bodyText}` },
  ]);
  return r.text;
}

export async function translate(
  http: HttpFn,
  cfg: LLMSettings,
  markdown: string,
  target: 'zh' | 'en',
): Promise<string> {
  const sys = target === 'en'
    ? '翻译成地道英文。保留 Markdown 结构与代码块，不要增删内容，不要加说明。'
    : '翻译成简体中文。保留 Markdown 结构与代码块，不要增删内容，不要加说明。';
  const hardCap = 24000;
  const bodyText = markdown.length > hardCap ? markdown.slice(0, hardCap) : markdown;
  const r = await chat(http, cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: bodyText },
  ], { maxTokens: Math.max(cfg.maxTokens, 2000) });
  return r.text;
}
