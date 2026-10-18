/**
 * 「逃出 any」的类型桥接层。
 *
 * Obsidian 插件跑在 Electron 渲染进程里，但 TypeScript 的 DOM 类型库不认识这几样东西：
 *   - window.require('electron' / 'child_process' / 'os')
 *   - <webview> 元素（Obsidian 开了 webviewTag，但没有对应类型）
 *   - --remote-debugging-port 的 /json 返回
 *
 * 这些位置如果写 `(window as any).require`，后面每次取属性/调用都会触发
 * no-unsafe-member-access / no-unsafe-call / no-unsafe-argument。
 * 统一在这里收口一次，调用点拿到具体类型，规则自然不再报。
 *
 * 纪律：这个文件里允许出现 any（只在 unknown → 具体类型的收窄处），
 * 业务代码不得再自己 (x as any)。
 */

/* ------------------------------- Node / Electron ------------------------------ */

export interface NodeOs {
  homedir?: () => string;
}

export interface CliReadable {
  on(event: 'data', cb: (chunk: { toString(): string }) => void): unknown;
}

export interface CliChild {
  stdout?: CliReadable | null;
  stderr?: CliReadable | null;
  on(event: 'error', cb: (e: unknown) => void): unknown;
  on(event: 'close', cb: (code: number | null) => void): unknown;
}

export interface ChildProcessModule {
  spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => CliChild;
}

export interface CookieItem {
  name: string;
  value: string;
  domain?: string;
}

export interface SessionLike {
  cookies?: {
    get?: (filter: { domain?: string }) => Promise<CookieItem[] | undefined>;
  };
  clearStorageData?: (opts: Record<string, unknown>) => Promise<void>;
}

export interface ElectronModule {
  remote?: { session?: { defaultSession?: SessionLike } };
}

/** 运行时可用的 node require（Electron 注入；沙箱/移动端可能没有） */
export type NodeRequire = <T = unknown>(m: string) => T | null;

export function nodeRequire(): NodeRequire | null {
  const w = window as unknown as { require?: NodeRequire };
  return typeof w.require === 'function' ? w.require : null;
}

function safeRequire<T>(mod: string): T | null {
  const req = nodeRequire();
  if (!req) return null;
  try {
    return req<T>(mod);
  } catch {
    return null;
  }
}

export function electronModule(): ElectronModule | null {
  return safeRequire<ElectronModule>('electron');
}

export function childProcessModule(): ChildProcessModule | null {
  return safeRequire<ChildProcessModule>('child_process');
}

export function nodeOs(): NodeOs | null {
  return safeRequire<NodeOs>('os');
}

/** process.env（GUI 进程里 PATH 通常残缺，需要自己补） */
export function processEnv(): Record<string, string> {
  const w = window as unknown as { process?: { env?: Record<string, string> } };
  return w.process?.env ?? {};
}

/* --------------------------------- webview --------------------------------- */

type WebviewEvent = 'dom-ready' | 'did-navigate' | 'did-navigate-in-page';

export interface WebviewElement extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  addEventListener(type: WebviewEvent, cb: () => void): void;
  addEventListener(type: string, cb: (ev: Event) => void): void;
}

declare global {
  // Electron 的 <webview> 标签不在标准 DOM 类型表里；声明进来后就能用 Obsidian 的 createEl 创建
  interface HTMLElementTagNameMap {
    webview: WebviewElement;
  }
}

/** 创建 <webview>；浏览器端（无 webviewTag）会抛错，调用方自行兜底 */
export function createWebviewElement(): WebviewElement {
  return createEl('webview');
}

/* ------------------------------ Obsidian adapter ----------------------------- */

/** vault.adapter 在桌面端是 FileSystemAdapter，有 getBasePath() */
export function vaultBasePath(adapter: unknown): string | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const fn = (adapter as { getBasePath?: unknown }).getBasePath;
  if (typeof fn !== 'function') return undefined;
  const out: unknown = (fn as (...args: unknown[]) => unknown).call(adapter);
  return typeof out === 'string' ? out : undefined;
}

/* ----------------------------------- CDP ----------------------------------- */

export interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/* ------------------------------- 安全 JSON 解析 ------------------------------ */

/** JSON.parse 不抛错版本；返回 unknown，强制调用方收窄 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function asStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function asNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/** 从对象里按顺序取第一个非空字符串字段 */
export function pickStr(o: unknown, ...keys: string[]): string {
  if (!isObj(o)) return '';
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** 从对象里按顺序取第一个数字字段 */
export function pickNum(o: unknown, ...keys: string[]): number {
  if (!isObj(o)) return 0;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/** 从对象里取子对象，取不到返回 null */
export function pickObj(o: unknown, key: string): Record<string, unknown> | null {
  if (!isObj(o)) return null;
  const v = o[key];
  return isObj(v) ? v : null;
}

/** 从对象里取数组，取不到返回空数组 */
export function pickArr(o: unknown, key: string): unknown[] {
  if (!isObj(o)) return [];
  const v = o[key];
  return Array.isArray(v) ? v : [];
}
