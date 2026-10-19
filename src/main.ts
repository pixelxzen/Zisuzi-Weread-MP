import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  type TAbstractFile,
  normalizePath,
  requestUrl,
  setIcon,
  type SettingDefinitionItem,
} from 'obsidian';
import {
  WereadClient,
  checkCookie,
  describeCookieCheck,
  normalizeCookie,
  fetchProfile,
  fetchCurrentUser,
  probeAccess,
  type AccessProbe,
  type ArticleItem,
  type HttpFn,
  RiskError,
  WEREAD_UA,
  extractMpOriginalUrl,
} from './core/weread';
import { htmlToMarkdown, replaceImagePlaceholders, replaceMediaPlaceholders, safeFileName } from './core/html2md';
import { WmcView, VIEW_TYPE_WMC } from './host/view-linear';
import { BackfillModal } from './host/backfill-modal';
import { QrLoginModal } from './host/qr-login-modal';
import { ASSET_AVATAR, ASSET_MP_QR, ASSET_TIP_QR } from './core/assets';
import type { BfItem, BfProgress, BfResult } from './core/bf';
import {
  childProcessModule,
  createWebviewElement,
  electronModule,
  isArr,
  isObj,
  nodeOs,
  nodeRequire,
  parseJson,
  pickArr,
  pickNum,
  pickObj,
  platformName,
  processEnv,
  vaultBasePath,
  type CliChild,
  type CdpTarget,
  type CookieItem,
  type WebviewElement,
} from './core/typed';
import { WereadAgentApi, fetchApiKey } from './core/weread-api';
import {
  LLM_DEFAULTS,
  PROVIDERS,
  summarize as llmSummarize,
  testConnection as testLLM,
  quotaToday,
  checkQuota,
  validateConfig,
  type LLMSettings,
  type ProviderId,
} from './core/llm';

/* ---------------------------------- types --------------------------------- */

export interface AccountRef {
  name: string;
  bookId: string;
}

export interface LoginProfile {
  name: string;
  avatar: string;
  avatarPath?: string;
  vid: string;
  desc?: string;
}

export interface WMSettings {
  cookie: string;
  wereadApiKey: string;
  accounts: AccountRef[];
  shelfAccounts: AccountRef[];
  loginProfile?: LoginProfile;
  layout: 'card' | 'feed' | 'official' | 'compact';
  theme: 'linear' | 'brand';
  maxMediaMB: number;
  panelOpen: boolean;
  agent: AgentSettings;
  agentDocked: boolean;
  /** true = 用 Obsidian 自带 session 的登录态（不手动传 Cookie） */
  useSession?: boolean;
  /** 最近一次实测的网页登录态（列表/正文用），undefined = 没测过 */
  webLoginOk?: boolean;
  webLoginAt?: number;
  webLoginMsg?: string;
  outputDir: string;
  listWidth: number;
  llm: LLMSettings;
  pages: number;
  intervalMin: number;
  maxPerRun: number;
  maxPerAccount: number;
  /** 每轮最多检查多少个公众号的列表（按游标轮转，防止一次把全量号都拉一遍） */
  maxAccountsPerRun: number;
  /**
   * 防风控保护。开启时每次启动都会把速率参数收敛到实测安全档，
   * 不受旧配置或手动误调影响。设为 false 才允许自由调参。
   */
  rateSafeMode?: boolean;
  delayListMs: number;
  delayContentMs: number;
  downloadImages: boolean;
  autoStart: boolean;
}

interface ProcessedEntry {
  account: string;
  title: string;
  time: number;
  path: string;
  at: number;
}

interface DiscoveredEntry {
  account: string;
  title: string;
  time: number;
  readNum?: number;
  likeNum?: number;
  picUrl?: string;
  localCover?: string;
  /** 列表接口自带的摘要。图片类文章（小绿书）没有 js_content，这是唯一正文线索 */
  digest?: string;
  /** 公众号原文地址（从正文 og:url 提取），抓过正文后才有 */
  mpUrl?: string;
}

interface WMState {
  processed: Record<string, ProcessedEntry>;
  discovered?: Record<string, DiscoveredEntry>;
  read?: Record<string, number>;
  summaries?: Record<string, string>;
  accountOffsets?: Record<string, number>;
  /** 该号列表已翻到底（存量固定，不必再翻） */
  accountDone?: Record<string, boolean>;
  llmQuota?: { day: string; count: number };
  lastRun?: { at: number; found: number; written: number; skipped: number; error?: string };
  watchSince?: number;
  /** 下一轮从第几个公众号开始检查（配合 maxAccountsPerRun 轮转） */
  accountCursor?: number;
  /** 列表接口被限频的冷却截止时间；未到期前一律不发列表请求 */
  listCooldownUntil?: number;
  /** 连续命中 -2014 的次数，用于指数退避 */
  listCooldownHits?: number;
  /** 已做过「限频安全默认值」迁移，防止每次启动都覆盖用户设置 */
  migratedRateLimit?: boolean;
  /** 已执行过「关闭启动时自动盯采」的一次性迁移（用户要求不要自动归档） */
  noAutoArchive?: boolean;
  /**
   * reviewId → 公众号原文地址。
   * 列表接口的 mpInfo 只有 originalId（内部 ID），没有 URL，地址只能从正文 og:url 抠；
   * 这里缓存「按需取到」的结果，侧栏「原文」直接展示，不再每次重新请求。
   */
  mpUrls?: Record<string, string>;
}

const DEFAULTS: WMSettings = {
  cookie: '',
  wereadApiKey: '',
  accounts: [],
  shelfAccounts: [],
  layout: 'card',
  theme: 'linear',
  maxMediaMB: 50,
  panelOpen: false,
  agent: { preset: 'hermes', cmd: '', args: [], cwd: '' },
  agentDocked: true,
  outputDir: '微信读书公众号',
  listWidth: 300,
  llm: { ...LLM_DEFAULTS },
  pages: 1,
  intervalMin: 45,
  maxPerRun: 4,
  maxPerAccount: 1,
  maxAccountsPerRun: 3,
  rateSafeMode: true,
  delayListMs: 6000,
  delayContentMs: 4500,
  downloadImages: true,
  autoStart: false,
};

const MIN_INTERVAL = 15; // 风控下限：低于 15 分钟不进风控红线

/**
 * 防风控安全档（实测结论见 docs/QR-LOGIN.md）。
 * 触发 -2014 的真实原因是「一轮把 27 个号全拉一遍」= 27 次请求/轮 + 封面图，
 * 按 30 分钟一轮算一天 1296 次，且是 1.2 秒间隔的连续突发。
 * 收敛后：每轮 3 次、间隔 6 秒、45 分钟一轮 ≈ 96 次/天，速率也平缓。
 */
const SAFE_RATE = {
  maxAccountsPerRun: 3,
  delayListMs: 6000,
  intervalMin: 45,
  delayContentMs: 4500,
} as const;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 并发受限的批量执行。
 * 图片/音视频走 mmbiz CDN，和「列表接口」不是同一条限流通道，
 * 没必要为了避险串行 + 每张等 2 秒；限制并发数就足够温和。
 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function fmtDate(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ymdNow(): string {
  return fmtDate(Math.floor(Date.now() / 1000));
}

/** 按魔数判图片扩展名（微信 CDN 会把 PNG 挂在 .jpg 名下） */
function guessExt(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  return 'jpg';
}

/* ------------------------------ 本地 Agent 适配层 ------------------------------ */

export interface AgentSettings {
  preset: string;
  cmd: string;
  args: string[];
  cwd: string;
}

export interface AgentPreset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  hint: string;
}

/** 每个预设的 args 里 {prompt} 会被替换成用户输入 */
export const AGENT_PRESETS: AgentPreset[] = [
  { id: 'hermes', label: 'Hermes（默认）', cmd: 'hermes', args: ['-z', '{prompt}'], hint: 'hermes -z "<prompt>"' },
  {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'text'],
    hint: 'claude -p "<prompt>" --output-format text',
  },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', args: ['exec', '{prompt}'], hint: 'codex exec "<prompt>"' },
  { id: 'kimi', label: 'Kimi CLI', cmd: 'kimi', args: ['-p', '{prompt}'], hint: 'kimi -p "<prompt>"' },
  { id: 'gemini', label: 'Gemini CLI', cmd: 'gemini', args: ['-p', '{prompt}'], hint: 'gemini -p "<prompt>"' },
  { id: 'cursor', label: 'Cursor Agent', cmd: 'cursor-agent', args: ['-p', '{prompt}'], hint: 'cursor-agent -p "<prompt>"' },
  { id: 'custom', label: '自定义命令', cmd: '', args: [], hint: '自己填命令，{prompt} 是占位符' },
];

/* --------------------------------- plugin --------------------------------- */

export interface WatchLogItem {
  at: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'err';
}

export interface WatchStatus {
  running: boolean;
  busy: boolean;
  phase: 'idle' | 'list' | 'fetch' | 'done' | 'cooldown';
  account?: string;
  accountIndex: number;
  accountTotal: number;
  queueTotal: number;
  found: number;
  written: number;
  skipped: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastError?: string;
  log: WatchLogItem[];
}

export default class WereadMpCatcher extends Plugin {
  settings: WMSettings = { ...DEFAULTS };
  state: WMState = { processed: {} };
  private timer: number | null = null;
  private running = false;
  /** 本次会话内确认「这篇没有公众号原文地址」的 reviewId，避免反复请求 */
  private mpUrlMiss = new Set<string>();
  /** 正在飞的取地址请求（同一个 reviewId 只发一次） */
  private mpUrlPending = new Map<string, Promise<string>>();
  /**
   * 最近抓过的正文 HTML（只留 3 篇，约 10MB 内存）。
   * 一篇 3.5MB，归档之后马上点「原文」不该再下一次。
   */
  private contentCache = new Map<string, string>();
  private loginPolling = false;
  private statusEl: HTMLElement | null = null;

  private watch: WatchStatus = {
    running: false,
    busy: false,
    phase: 'idle',
    accountIndex: 0,
    accountTotal: 0,
    queueTotal: 0,
    found: 0,
    written: 0,
    skipped: 0,
    log: [],
  };
  private watchListeners = new Set<() => void>();

  onWatch(cb: () => void): () => void {
    this.watchListeners.add(cb);
    return () => {
      this.watchListeners.delete(cb);
    };
  }

  private emitWatch(): void {
    for (const cb of this.watchListeners) {
      try {
        cb();
      } catch {
        /* noop */
      }
    }
  }

  private pushLog(text: string, kind: WatchLogItem['kind'] = 'info'): void {
    this.watch.log.push({ at: Date.now(), text, kind });
    if (this.watch.log.length > 60) this.watch.log.shift();
  }

  getWatchStatus(): WatchStatus {
    return this.watch;
  }

  private notifyViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WMC)) {
      const v = leaf.view as unknown as { render?: () => void };
      try {
        v?.render?.();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * HTTP 层：Obsidian requestUrl + 8s 超时兜底。
   * 教训：v0.9.2 曾改用 Electron net.request + 独立 partition，结果 response 事件不触发，
   * 请求永久 pending → 界面"假死"。net.request 在 renderer 里不可靠，已回退。
   */
  private rawHttp = async (url: string, headers: Record<string, string>) => {
    let timer: number | undefined;
    try {
      const r = await Promise.race([
        requestUrl({ url, method: 'GET', headers, throw: false }),
        new Promise<never>((_, rej) => {
          timer = window.setTimeout(() => rej(new Error(`请求超时 8 秒：${url.slice(0, 70)}`)), 8000);
        }),
      ]);
      return { status: r.status, text: r.text, bytes: r.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };

  /**
   * HTTP 双保险：
   * 1) 先用插件里存的 Cookie；
   * 2) 若返回风控/登录失效码（-20xx），去掉 Cookie 头重试一次
   *    —— Obsidian 的 requestUrl 走 Electron defaultSession，用户在本应用内
   *       登录微信读书后的新登录态就在里面，这条兜底能自动接管。
   */
  private respOk(r: { status: number; text: string }): boolean {
    if (r.status !== 200) return false;
    // 微信读书的错误码字段名有 errCode / errcode / errorCode 几种写法
    const m = /"err(?:Code|code|orCode)"\s*:\s*(-?\d+)/.exec(r.text);
    if (m && /^-20\d\d$/.test(m[1])) return false;
    if (/^-20\d\d$/.test(r.text.slice(0, 40).trim())) return false;
    return true;
  }

  private http: HttpFn = async (url: string, headers: Record<string, string>) => {
    const useSession = !!this.settings.useSession;
    const h1: Record<string, string> = { ...headers };
    if (useSession) {
      delete h1.Cookie;
      delete h1.cookie;
    }
    const r1 = await this.rawHttp(url, h1);
    if (this.respOk(r1)) return r1;
    // 反向兜底：session 模式失败就试手动 Cookie，反之亦然
    const h2: Record<string, string> = { ...headers };
    if (useSession) {
      if (this.settings.cookie) h2.Cookie = this.settings.cookie;
    } else {
      delete h2.Cookie;
      delete h2.cookie;
    }
    try {
      const r2 = await this.rawHttp(url, h2);
      if (this.respOk(r2)) {
        // 兜底成功 → 记住哪种方式可用
        this.settings.useSession = !useSession;
        return r2;
      }
    } catch {
      /* 保留第一次结果 */
    }
    return r1;
  };

  /* ---------------- Chrome 登录兜底（Windows 上最稳的一条路） ---------------- */

  /** 找本机 Chrome / Edge 可执行文件（Windows 与 macOS 都覆盖） */
  findBrowserExe(): string {
    const req = nodeRequire();
    const fs = req ? req<{ existsSync?: (p: string) => boolean }>('fs') : null;
    if (!fs?.existsSync) return '';
    const env = processEnv();
    const cands: string[] = [];
    if (platformName() === 'win32') {
      const pf = env.ProgramFiles || 'C:////Program Files';
      const pf86 = env['ProgramFiles(x86)'] || 'C:////Program Files (x86)';
      const local = env.LOCALAPPDATA || '';
      cands.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`);
      cands.push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
      if (local) cands.push(`${local}\\Google\\Chrome\\Application\\chrome.exe`);
      cands.push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
      cands.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
    } else {
      cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    }
    return cands.find((p) => fs.existsSync?.(p)) || '';
  }

  /** 通过 CDP 读取 weread 域 cookie（Chrome 需以 --remote-debugging-port 启动） */
  private async readCdpCookies(port: number): Promise<string | null> {
    try {
      const r = await requestUrl({ url: `http://127.0.0.1:${port}/json/list`, method: 'GET', throw: false });
      if (r.status !== 200) return null;
      const list = parseJson(r.text);
      const targets = isArr(list) ? list.filter(isObj).map((o): CdpTarget => o) : [];
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
      const wsUrl = page?.webSocketDebuggerUrl;
      if (!wsUrl) return null;
      const jar = await new Promise<Record<string, string> | null>((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = window.setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* noop */
          }
          resolve(null);
        }, 6000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
        ws.onmessage = (ev) => {
          try {
            const msg = parseJson(String(ev.data));
            const result = pickObj(msg, 'result');
            const cookies = pickArr(result, 'cookies');
            if (pickNum(msg, 'id') === 1 && cookies.length) {
              window.clearTimeout(timer);
              ws.close();
              const out: Record<string, string> = {};
              for (const c of cookies) {
                if (!isObj(c)) continue;
                const name = typeof c['name'] === 'string' ? c['name'] : '';
                const value = typeof c['value'] === 'string' ? c['value'] : '';
                const domain = typeof c['domain'] === 'string' ? c['domain'] : '';
                if (name.startsWith('wr_') && /weread/.test(domain) && value) out[name] = value;
              }
              resolve(out);
            }
          } catch {
            /* 忽略非 JSON 帧 */
          }
        };
        ws.onerror = () => {
          window.clearTimeout(timer);
          resolve(null);
        };
      });
      if (!jar) return null;
      const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      return ck || null;
    } catch {
      return null;
    }
  }

  /** 关闭由本插件拉起的浏览器（CDP Browser.close 比 kill 干净） */
  private async closeCdpBrowser(port: number): Promise<void> {
    try {
      const v = await requestUrl({ url: `http://127.0.0.1:${port}/json/version`, method: 'GET', throw: false });
      if (v.status !== 200) return;
      const info = parseJson(v.text);
      const wsUrl = isObj(info) && typeof info['webSocketDebuggerUrl'] === 'string' ? info['webSocketDebuggerUrl'] : '';
      if (!wsUrl) return;
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(wsUrl);
        const done = (): void => {
          try {
            ws.close();
          } catch {
            /* noop */
          }
          resolve();
        };
        window.setTimeout(done, 2500);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        ws.onmessage = done;
        ws.onerror = done;
      });
    } catch {
      /* noop */
    }
  }

  /** 拉起本机 Chrome/Edge 让用户正常登录，登录后自动导入 cookie（Windows 推荐） */
  async loginWithChrome(): Promise<void> {
    const spawn = childProcessModule()?.spawn;
    if (!spawn) {
      new Notice('当前环境不支持拉起浏览器（仅桌面端可用）');
      return;
    }
    const exe = this.findBrowserExe();
    if (!exe) {
      new Notice('没找到 Chrome / Edge，请先安装，或在下方手动粘贴 cookie', 10000);
      return;
    }
    const port = 9333 + Math.floor(Math.random() * 60);
    const base = vaultBasePath(this.app.vault.adapter) || '';
    const profile = `${base}/${this.manifest.dir}/.chrome-login`;
    let child: CliChild | null = null;
    try {
      child = spawn(
        exe,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          'https://weread.qq.com/',
        ],
        { detached: true },
      );
    } catch (e) {
      new Notice(`启动浏览器失败：${String(e).slice(0, 80)}`, 10000);
      return;
    }
    new Notice('已打开 Chrome 登录窗口：在里面登录微信读书（扫码），登录后自动导入（最长等 6 分钟）', 10000);

    const t0 = Date.now();
    while (Date.now() - t0 < 6 * 60 * 1000) {
      await sleep(2500);
      const ck = await this.readCdpCookies(port);
      if (!ck) continue;
      const chk = checkCookie(ck);
      if (!chk.ok) continue;
      this.settings.cookie = normalizeCookie(ck);
      this.settings.useSession = false;
      await this.saveAll();
      await this.closeCdpBrowser(port);
      try {
        child?.kill?.();
      } catch {
        /* noop */
      }
      const prof = await this.refreshProfile().catch(() => null);
      const n = await this.syncAccountsFromShelf().catch(() => 0);
      await this.checkWebLogin().catch(() => null);
      this.notifyViews();
      this.renderStatus();
      this.emitWatch();
      new Notice(`登录成功${prof?.name ? `：${prof.name}` : ''}${n ? ` · 书架 ${n} 个` : ''}`, 10000);
      return;
    }
    new Notice('等待超时：可关闭该 Chrome 窗口，改用手动粘贴 cookie', 10000);
  }

  /**
   * 从正在运行的 Chrome 通过 CDP 读取完整登录态（含 wr_gid 这类会话级 cookie）。
   * 前提：Chrome 以 --remote-debugging-port=9222 启动；已经登录过 weread.qq.com。
   */
  async importCookieFromChrome(): Promise<string> {
    let targets: CdpTarget[] = [];
    try {
      const r = await requestUrl({ url: 'http://127.0.0.1:9222/json', method: 'GET', throw: false });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const parsed = parseJson(r.text);
      targets = isArr(parsed) ? parsed.filter(isObj).map((o): CdpTarget => o) : [];
    } catch (e) {
      return `CDP_OFF：连不上 127.0.0.1:9222（${String(e).slice(0, 50)}）`;
    }
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
    if (!page?.webSocketDebuggerUrl) return 'CDP_OFF：没有可用页面';

    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) return 'CDP_OFF：页面没有调试端点';

    let cookies: CookieItem[] = [];
    try {
      cookies = await new Promise<CookieItem[]>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = window.setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* noop */
          }
          reject(new Error('WebSocket 超时'));
        }, 8000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
        ws.onmessage = (ev) => {
          try {
            const msg = parseJson(String(ev.data));
            const result = pickObj(msg, 'result');
            const list = pickArr(result, 'cookies');
            if (pickNum(msg, 'id') === 1 && list.length) {
              window.clearTimeout(timer);
              ws.close();
              resolve(list.filter(isObj) as unknown as CookieItem[]);
            }
          } catch {
            /* 忽略非 JSON 帧 */
          }
        };
        ws.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error('WebSocket 错误'));
        };
      });
    } catch (e) {
      return `CDP_FAIL：${String(e).slice(0, 60)}`;
    }

    const wr = cookies.filter((c) => c.name.startsWith('wr_') && /weread/.test(c.domain ?? ''));
    if (!wr.length) return 'NO_WEREAD_COOKIE：Chrome 里没找到 weread 登录态，先在浏览器登录一次';
    const jar: Record<string, string> = {};
    for (const c of wr) jar[c.name] = c.value;
    if (!jar.wr_vid || !jar.wr_skey) return `INCOMPLETE：只拿到 ${Object.keys(jar).join(',')}`;

    this.settings.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    this.settings.useSession = false;
    await this.saveAll();
    const web = await this.checkWebLogin();
    await this.refreshProfile().catch(() => null);
    await this.syncAccountsFromShelf().catch(() => 0);
    this.notifyViews();
    this.renderStatus();
    return web.ok
      ? `OK：导入 ${wr.length} 项（含 ${jar.wr_gid ? 'wr_gid' : '无 wr_gid'}）· ${web.msg}`
      : `IMPORTED_BUT_BAD：导入 ${wr.length} 项，但列表仍不通：${web.msg}`;
  }

  /** 探测 Obsidian 自带 session 里是否有有效登录态（不依赖已移除的 electron.remote） */
  async probeSessionLogin(): Promise<boolean> {
    const UA = WEREAD_UA;
    const acc = this.settings.shelfAccounts[0] || this.settings.accounts[0];
    // 首选判据：真的能拉到文章列表 —— 这才是我们要的能力
    if (acc?.bookId) {
      try {
        const r = await this.rawHttp(
          `https://weread.qq.com/web/mp/articles?bookId=${acc.bookId}&offset=0`,
          { 'User-Agent': UA, Referer: 'https://weread.qq.com/', Accept: 'application/json' },
        );
        if (r.status === 200 && /"subReviews"|"reviews"/.test(r.text) && !/"err(?:Code|code)"\s*:\s*-20\d\d/.test(r.text)) {
          return true;
        }
      } catch {
        /* 继续兜底 */
      }
    }
    // 兜底：书架接口
    for (const u of ['https://weread.qq.com/web/shelf/sync?synckey=0', 'https://weread.qq.com/web/user?userVid=']) {
      try {
        const r = await this.rawHttp(u, { 'User-Agent': UA, Referer: 'https://weread.qq.com/', Accept: 'application/json, text/plain, */*' });
        if (r.status !== 200) continue;
        if (/"err(?:Code|code)"\s*:\s*-20\d\d/.test(r.text)) continue;
        if (/"books"|"archive"|"synckey"|"userVid"/.test(r.text)) return true;
      } catch {
        /* 下一个 */
      }
    }
    return false;
  }


  async onload() {
    await this.loadAll();

    this.statusEl = this.addStatusBarItem();
    this.renderStatus();

    this.registerView(VIEW_TYPE_WMC, (leaf) => new WmcView(leaf, this));
    // 清理历史遗留的重复面板（同类型 leaf > 1，只保留第一个）
    this.app.workspace.onLayoutReady(() => {
      const dup = this.app.workspace.getLeavesOfType(VIEW_TYPE_WMC);
      if (dup.length > 1) dup.slice(1).forEach((leaf) => leaf.detach());
    });
    this.addRibbonIcon('rss', '微信读书公众号：打开列表', () => void this.activateView());
    this.addCommand({
      id: 'open-list',
      name: '打开公众号列表',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'fetch-now',
      name: '立即抓取一轮',
      callback: () => void this.runOnce(true),
    });
    this.addCommand({
      id: 'toggle-watch',
      name: '开始 / 停止自动盯采',
      callback: () => (this.timer ? this.stopWatch(true) : this.startWatch(true)),
    });
    this.addCommand({
      id: 'open-login',
      name: '打开微信读书登录窗口',
      callback: () => this.openLoginWindow(),
    });
    this.addCommand({
      id: 'logout-account',
      name: '退出微信读书账号（清空登录态后可重新扫码）',
      callback: () => void this.logoutAccount(),
    });
    this.addCommand({
      id: 'repair-images',
      name: '补全当前笔记的图片（重新采集）',
      callback: () => void this.repairActiveNote(),
    });
    this.addCommand({
      id: 'repair-all-images',
      name: '补全所有缺图笔记（批量重新采集）',
      callback: () => void this.repairAllNotes(),
    });
    this.addCommand({
      id: 'toggle-theme',
      name: '切换界面主题（linear ⇄ 紫苏子品牌）',
      callback: async () => {
        this.settings.theme = this.settings.theme === 'brand' ? 'linear' : 'brand';
        await this.saveAll();
        new Notice(`界面主题：${this.settings.theme === 'brand' ? '紫苏子品牌' : 'Linear 中性'}`);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WMC)) {
          const v = leaf.view as unknown as { applyTheme?: () => void; render?: () => void };
          v?.applyTheme?.();
          v?.render?.();
        }
      },
    });
    this.addCommand({
      id: 'selftest',
      name: '诊断：登录态 + 公众号接口（分清过期/被限）',
      callback: async () => {
        const ck = normalizeCookie(this.settings.cookie || '');
        const probe = await probeAccess(this.http, ck);
        const tag =
          probe.verdict === 'ok'
            ? '正常'
            : probe.verdict === 'rate-limited'
              ? '被限频（-2014）'
              : probe.verdict === 'restricted'
                ? '被限（-2041）'
                : probe.verdict === 'expired'
                  ? '过期'
                  : probe.verdict === 'no-cookie'
                    ? '未登录'
                    : '未知';
        this.pushLog(
          `自检：${tag}｜账号=${probe.account ?? '读不到'}｜列表码=${probe.listCode}｜${probe.hint}`,
          probe.verdict === 'ok' ? 'ok' : 'err',
        );
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WMC)) {
          const v = leaf.view as unknown as { render?: () => void };
          v?.render?.();
        }
        new Notice(
          `自检结果：${tag}\n账号：${probe.account ?? '读不到'}\n列表接口：${probe.listCode}\n${probe.hint}`,
          12000,
        );
      },
    });
    void this.autoDetectSession();
    this.addCommand({
      id: 'diagnose-login',
      name: '诊断登录态（写入 诊断.txt）',
      callback: () => void this.diagnoseLogin(),
    });
    this.addCommand({
      id: 'backfill',
      name: '归档某个号的全部历史（分批·防风控）',
      callback: () => this.openBackfill(),
    });

    this.addSettingTab(new WMSettingTab(this.app, this));

    // 用户明确要求「不要自动归档」。
    // 一次性把历史配置里的 autoStart 关掉（只做一次，之后用户在设置页手动打开仍然生效），
    // 避免旧 data.json / 从备份恢复的配置让插件一启动就自己跑。
    if (!this.state.noAutoArchive) {
      this.state.noAutoArchive = true;
      const wasOn = this.settings.autoStart;
      this.settings.autoStart = false;
      await this.saveAll();
      if (wasOn) {
        this.pushLog('已关闭「启动时自动盯采」：不会自动抓取，需手动点「开始更新」', 'warn');
      }
    }

    if (this.settings.autoStart) this.startWatch(false);
  }

  onunload() {
    this.stopWatch(false);
    this.statusEl?.remove();
    this.statusEl = null;
  }

  /* ------------------------------- persistence ------------------------------ */

  async loadAll() {
    const raw = (await this.loadData()) as { settings?: Partial<WMSettings>; state?: WMState } | null;
    this.settings = { ...DEFAULTS, ...(raw?.settings ?? {}) };
    this.state = raw?.state ?? { processed: {} };
    // 防风控保护：把速率参数收敛到实测安全的档位。
    // 直接改 data.json 没用 —— 运行中的插件会用内存里的 settings 回写覆盖，
    // 所以必须在每次加载时收敛，才不会被打回危险区。
    if (this.settings.rateSafeMode !== false) {
      const S = this.settings;
      if (!S.maxAccountsPerRun || S.maxAccountsPerRun > SAFE_RATE.maxAccountsPerRun) {
        S.maxAccountsPerRun = SAFE_RATE.maxAccountsPerRun;
      }
      if (!S.delayListMs || S.delayListMs < SAFE_RATE.delayListMs) S.delayListMs = SAFE_RATE.delayListMs;
      if (!S.intervalMin || S.intervalMin < SAFE_RATE.intervalMin) S.intervalMin = SAFE_RATE.intervalMin;
      if (!S.delayContentMs || S.delayContentMs < SAFE_RATE.delayContentMs) {
        S.delayContentMs = SAFE_RATE.delayContentMs;
      }
    }
    if (!this.state.processed) this.state.processed = {};
  }

  async saveAll() {
    const payload: { settings: WMSettings; state: WMState } = {
      settings: { ...this.settings },
      state: this.state,
    };
    // 防护：永不把不完整的 cookie 写进磁盘（否则会覆盖掉可用登录态）
    const now = checkCookie(this.settings.cookie || '');
    if (!now.ok) {
      const disk = (await this.loadData()) as { settings?: Partial<WMSettings> } | null;
      const prev = disk?.settings?.cookie ?? '';
      if (checkCookie(prev).ok) {
        payload.settings.cookie = prev;
        this.settings.cookie = prev;
      }
    }
    await this.saveData(payload);
  }

  /* --------------------------------- cookie -------------------------------- */

  /** 尝试从 Obsidian(Electron) session 读取 weread cookie；不可用时返回 null */
  async tryReadSessionCookie(): Promise<string | null> {
    try {
      // 运行时按需加载 electron 模块：静态 import 会在移动端直接崩
      const cookies = electronModule()?.remote?.session?.defaultSession?.cookies;
      if (!cookies?.get) return null;
      const list = await cookies.get({ domain: '.weread.qq.com' });
      if (!list?.length) return null;
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return null;
    }
  }

  /**
   * 扫码登录入口（命令面板 / 设置页共用）。
   * 旧实现依赖 webview 读 document.cookie，Obsidian 默认不放行 → 扫码永远没反应；
   * 这里改为纯 HTTP 扫码：微信二维码 + 轮询 + 用 wx_code 换 cookie。
   */
  openLoginWindow() {
    this.startQrLogin();
  }

  /** 打开扫码登录弹窗，成功后落盘并刷新账号/书架/状态 */
  startQrLogin(): void {
    new QrLoginModal(this.app, {
      onSuccess: async (cookie) => {
        this.settings.cookie = normalizeCookie(cookie);
        this.settings.useSession = false;
        await this.saveAll();
        const key = await this.refreshApiKey().catch(() => null);
        const prof = await this.refreshProfile().catch(() => null);
        const n = await this.syncAccountsFromShelf().catch(() => 0);
        const web = await this.checkWebLogin().catch(() => ({ ok: false, msg: '未知' }));
        this.notifyViews();
        this.renderStatus();
        this.emitWatch();
        new Notice(
          `登录成功${prof?.name ? `：${prof.name}` : ''}${key ? ' · 已换出官方 Key' : ''}${
            n ? ` · 书架 ${n} 个` : ''
          }${web.ok ? ' · 列表可用' : ` · 列表仍不通：${web.msg}`}`,
          web.ok ? 10000 : 16000,
        );
      },
    }).open();
  }

  /** 轮询直到 cookie 成熟（wr_skey 为长串）。扫码确认前会拿到 8 字符临时值，必须等它变长。 */
  private async waitForMatureCookie(maxWaitMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const ck = await this.tryReadSessionCookie();
      if (ck) {
        const chk = checkCookie(ck);
        if (chk.ok) {
          this.settings.cookie = ck;
          await this.saveAll();
          void this.verifyCookieLive(false);
          this.emitWatch();
          return true;
        }
      }
      await new Promise((r) => window.setTimeout(r, 2000));
    }
    return false;
  }

  async importSessionCookie(): Promise<boolean> {
    const ck = await this.tryReadSessionCookie();
    if (!ck) return false;
    const chk = checkCookie(ck);
    if (!chk.ok) {
      new Notice(`读到的 Cookie 不完整（缺 ${chk.missing.join(', ')}），已拒绝覆盖现有配置`, 8000);
      return false;
    }
    this.settings.cookie = ck;
    await this.saveAll();
    await this.verifyCookieLive(true);
    return true;
  }

  /* ------------------------------ 补图 / 再采集 ------------------------------ */

  /**
   * 修复一篇笔记的图片：从 source 里的 reviewId 重新拉正文，下载全部图片，
   * 再把笔记里的图片链接重写为带尖括号的相对路径（路径含空格时必需）。
   */
  async repairNote(f: TFile): Promise<{ ok: number; fail: number; total: number }> {
    const md = await this.app.vault.read(f);
    // 兼容三种历史格式：source: weread://<rid> / source: <mp.weixin 原文> / 正文里的 reviewId
    const m = /MP_WXS_\d+_WR[A-Za-z0-9]+/.exec(md);
    if (!m) throw new Error('这篇笔记里找不到 reviewId，无法定位原文');
    const reviewId = m[0];
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) throw new Error('登录态无效，请先去设置里扫码登录');

    const client = new WereadClient(this.http, cookie);
    const html = await client.getContentHtml(reviewId);
    const { images } = htmlToMarkdown(html);
    if (!images.length) throw new Error('正文里没有找到图片');

    const base = safeFileName(f.basename);
    const parentDir = f.parent?.path && f.parent.path !== '/' ? f.parent.path : this.settings.outputDir;
    const assetDir = normalizePath(`${parentDir}/assets/${base}`);
    await this.ensureFolder(assetDir);

    const localRel: string[] = [];
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < images.length; i++) {
      try {
        const buf = await client.fetchImage(images[i].src);
        const ext = guessExt(buf);
        const name = `img-${String(i + 1).padStart(2, '0')}.${ext}`;
        await this.app.vault.adapter.writeBinary(normalizePath(`${assetDir}/${name}`), buf);
        localRel.push(normalizePath(`assets/${base}/${name}`));
        ok++;
      } catch {
        localRel.push('');
        fail++;
      }
      await sleep(Math.max(600, this.settings.delayContentMs));
    }

    let idx = 0;
    const rewritten = md.replace(/!\[([^\]]*)\]\([^)]*\)/g, (whole, alt) => {
      const rel = localRel[idx++];
      if (!rel) return whole;
      return `![${alt || 'img'}](<${rel}>)`;
    });
    await this.app.vault.modify(f, rewritten);
    return { ok, fail, total: images.length };
  }

  async repairActiveNote(): Promise<void> {
    const f = this.app.workspace.getActiveFile();
    if (!f || f.extension !== 'md') {
      new Notice('先打开一篇公众号笔记，再运行这个命令');
      return;
    }
    const t = new Notice(`正在补全「${f.basename.slice(0, 20)}…」的图片`, 0);
    try {
      const r = await this.repairNote(f);
      t.hide();
      new Notice(`补全完成：成功 ${r.ok} / 共 ${r.total} 张${r.fail ? `，失败 ${r.fail}` : ''}`, 8000);
    } catch (e) {
      t.hide();
      new Notice(`补全失败：${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  /** 扫描笔记里指向不存在文件的图片，逐篇重采 */
  async repairAllNotes(): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.outputDir);
    const files: TFile[] = [];
    const walk = (node: TAbstractFile) => {
      if (node instanceof TFile) {
        if (node.extension === 'md') files.push(node);
        return;
      }
      if (node instanceof TFolder) {
        for (const child of node.children) walk(child);
      }
    };
    if (folder) walk(folder);
    if (!files.length) {
      new Notice(`「${this.settings.outputDir}」下没有笔记`);
      return;
    }

    const broken: TFile[] = [];
    for (const f of files) {
      const md = await this.app.vault.cachedRead(f);
      const links = [...md.matchAll(/!\[[^\]]*\]\(<?([^)>\n]+)>?\)/g)].map((m) => m[1]);
      const missing = links.some((p) => !p.startsWith('http') && !this.app.vault.getAbstractFileByPath(normalizePath(p)));
      if (missing) broken.push(f);
    }
    if (!broken.length) {
      new Notice('没有发现缺图的笔记 🎉');
      return;
    }

    const t = new Notice(`发现 ${broken.length} 篇缺图，开始补全…`, 0);
    let totalOk = 0;
    for (const f of broken) {
      try {
        const r = await this.repairNote(f);
        totalOk += r.ok;
      } catch {
        /* 单篇失败继续 */
      }
      await sleep(1500);
    }
    t.hide();
    new Notice(`补全完成：${broken.length} 篇 · 共下载 ${totalOk} 张图`, 10000);
  }

  /** 往笔记末尾追加内容（AI 处理结果写回） */
  async appendToNote(path: string, text: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !(f instanceof TFile)) throw new Error('笔记不存在');
    await this.app.vault.append(f, text);
  }

  /** 跑一遍本地 Agent CLI（流式回调）。默认 Hermes，可切 Claude Code / Codex / Kimi / Gemini / Cursor / 自定义 */
  async runAgent(prompt: string, onChunk?: (t: string) => void): Promise<{ code: number; out: string; err: string; cmd: string }> {
    // 运行时按需加载 child_process：静态 import 会在移动端直接崩
    const spawn = childProcessModule()?.spawn;
    if (!spawn) throw new Error('当前环境不支持执行本地命令（仅桌面端可用）');

    const cfg = this.settings.agent || { preset: 'hermes', cmd: '', args: [], cwd: '' };
    const preset = AGENT_PRESETS.find((p) => p.id === cfg.preset) || AGENT_PRESETS[0];
    const cmd = (cfg.preset === 'custom' && cfg.cmd ? cfg.cmd : preset.cmd).trim();
    const rawArgs = cfg.preset === 'custom' && cfg.args?.length ? cfg.args : preset.args;
    if (!cmd) throw new Error('还没配置 Agent 命令');
    const args = rawArgs.map((a) => a.replace('{prompt}', prompt));

    // Obsidian 是 GUI 进程，PATH 往往不完整（macOS 只有 /usr/bin:/bin，Windows 缺 npm 全局目录）—— 必须手工补全
    const isWin = platformName() === 'win32';
    const home = nodeOs()?.homedir?.() || '';
    const baseEnv = processEnv();
    const extraPaths = isWin
      ? [
          baseEnv.APPDATA ? `${baseEnv.APPDATA}\\npm` : '',
          baseEnv.LOCALAPPDATA ? `${baseEnv.LOCALAPPDATA}\\Programs` : '',
          baseEnv.LOCALAPPDATA ? `${baseEnv.LOCALAPPDATA}\\Microsoft\\WindowsApps` : '',
          home ? `${home}\\.local\\bin` : '',
          home ? `${home}\\.kimi-code\\bin` : '',
          baseEnv.ProgramFiles ? `${baseEnv.ProgramFiles}\\nodejs` : '',
          baseEnv.SystemRoot ? `${baseEnv.SystemRoot}\\System32` : '',
          baseEnv.SystemRoot ? `${baseEnv.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : '',
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          home ? `${home}/.local/bin` : '',
          home ? `${home}/.kimi-code/bin` : '',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ];
    const env = {
      ...baseEnv,
      PATH: [...extraPaths, baseEnv.PATH || ''].filter(Boolean).join(isWin ? ';' : ':'),
    };
    const cwd = cfg.cwd || vaultBasePath(this.app.vault.adapter) || undefined;

    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let child: CliChild;
      try {
        // Windows 的 claude/codex 等入口是 .cmd，不经 shell 直接 spawn 会 ENOENT
        child = spawn(cmd, args, { cwd, env, shell: isWin });
      } catch (e) {
        resolve({ code: -1, out: '', err: String(e), cmd });
        return;
      }
      child.stdout?.on('data', (d) => {
        const s = d.toString();
        out += s;
        onChunk?.(s);
      });
      child.stderr?.on('data', (d) => {
        err += d.toString();
      });
      child.on('error', (e) => resolve({ code: -1, out, err: `${err}\n${String(e)}`.trim(), cmd }));
      child.on('close', (code) => resolve({ code: code ?? -1, out, err, cmd }));
    });
  }

  /** 批量下载选中的文章（只下选的，不碰其他） */
  async archiveMany(rids: string[]): Promise<{ ok: number; fail: number }> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) throw new Error('登录态无效，请先扫码登录');
    const client = new WereadClient(this.http, cookie);
    let ok = 0;
    let fail = 0;
    const t = new Notice(`开始下载 ${rids.length} 篇…`, 0);
    for (let i = 0; i < rids.length; i++) {
      const rid = rids[i];
      const d = this.state.discovered?.[rid];
      if (!d) {
        fail++;
        continue;
      }
      try {
        const done = await this.fetchOne(client, { name: d.account, bookId: '' }, {
          reviewId: rid,
          title: d.title,
          time: d.time,
          readNum: d.readNum,
          likeNum: d.likeNum,
          picUrl: d.picUrl,
          mpName: d.account,
        });
        if (done) ok++;
        else fail++;
      } catch (e) {
        if (e instanceof RiskError) {
          t.hide();
          new Notice(`命中风控，已停止下载（成功 ${ok} 篇）`, 9000);
          break;
        }
        fail++;
      }
      t.setMessage(`下载中 ${i + 1}/${rids.length} · 成功 ${ok}`);
      await sleep(this.settings.delayContentMs);
    }
    t.hide();
    await this.saveAll();
    this.notifyViews();
    return { ok, fail };
  }

  /* ------------------------------ 扫码登录 ------------------------------ */

  /**
   * 加载某个号的文章列表。reset=true 从第一页开始（首屏秒开 20 条），
   * 之后由 loadMoreForAccount 增量续拉（对齐网页版的滚动加载体验）。
   */
  async fetchAccountList(name: string, reset = true): Promise<number> {
    const acc =
      this.settings.accounts.find((a) => a.name === name) ||
      this.settings.shelfAccounts.find((a) => a.name === name);
    if (!acc?.bookId) return 0;
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) return 0;
    const client = new WereadClient(this.http, cookie);
    if (!this.state.discovered) this.state.discovered = {};
    if (!this.state.accountOffsets) this.state.accountOffsets = {};
    const offset = reset ? 0 : this.state.accountOffsets[acc.name] || 0;
    try {
      const items = await client.listArticles(acc.bookId, offset);
      let added = 0;
      for (const it of items) {
        if (!this.state.discovered[it.reviewId]) {
          this.state.discovered[it.reviewId] = {
            account: acc.name,
            title: it.title,
            time: it.time,
            readNum: it.readNum,
            likeNum: it.likeNum,
            picUrl: it.picUrl,
            digest: it.digest,
          };
          added++;
        }
      }
      this.state.accountOffsets[acc.name] = offset + items.length;
      if (items.length < 20) {
        if (!this.state.accountDone) this.state.accountDone = {};
        this.state.accountDone[acc.name] = true;
      }
      if (added || reset) await this.saveAll();
      this.notifyViews();
      if (reset && added) new Notice(`「${name}」首批 ${items.length} 篇已就绪，往下滚继续加载`, 5000);
      return items.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof RiskError) {
        new Notice(e.message, 10000);
      } else {
        new Notice(`加载「${name}」失败：${msg}`, 7000);
      }
      return 0;
    }
  }

  /** 滚到底时续拉下一页（20 条一页，与网页版一致） */
  /**
   * 静默增量同步：只拉最新几页，和本地缓存对比。
   * 一旦某页全是已知文章，说明作者没有新发（存量列表是固定的），立即停。
   * 这样选号时无需重新翻全部历史。
   */
  async syncNewArticles(name: string, maxPages = 5): Promise<number> {
    const acc =
      this.settings.accounts.find((a) => a.name === name) ||
      this.settings.shelfAccounts.find((a) => a.name === name);
    if (!acc?.bookId) return 0;
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) return 0;
    const client = new WereadClient(this.http, cookie);
    if (!this.state.discovered) this.state.discovered = {};
    let added = 0;
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      let items: ArticleItem[];
      try {
        items = await client.listArticles(acc.bookId, offset);
      } catch (e) {
        if (e instanceof RiskError) new Notice(e.message, 9000);
        break;
      }
      if (!items.length) break;
      let fresh = 0;
      for (const it of items) {
        if (!this.state.discovered[it.reviewId]) {
          this.state.discovered[it.reviewId] = {
            account: acc.name,
            title: it.title,
            time: it.time,
            readNum: it.readNum,
            likeNum: it.likeNum,
            picUrl: it.picUrl,
            digest: it.digest,
          };
          fresh++;
        }
      }
      added += fresh;
      if (fresh === 0) break; // 整页都认识 → 没有更新的了
      offset += items.length;
      await sleep(this.settings.delayListMs || 1200);
    }
    if (added) {
      await this.saveAll();
      this.notifyViews();
    }
    return added;
  }

  async loadMoreForAccount(name: string): Promise<{ added: number; hasMore: boolean }> {
    const before = Object.keys(this.state.discovered || {}).length;
    const got = await this.fetchAccountList(name, false);
    const after = Object.keys(this.state.discovered || {}).length;
    return { added: after - before, hasMore: got >= 20 };
  }

  /** 登出：清本地登录态 + 清 Electron session 里 weread 域 cookie（不清的话重扫码还是旧账号） */
  async logout(): Promise<void> {
    // 正在盯采就先停掉，否则空 cookie 的轮询会刷一堆 -2012 错误
    if (this.timer !== null) this.stopWatch(false);
    try {
      // 运行时按需加载 electron 模块：静态 import 会在移动端直接崩
      const session = electronModule()?.remote?.session?.defaultSession;
      if (session?.clearStorageData) {
        await session.clearStorageData({ origin: 'https://weread.qq.com', storages: ['cookies'] });
      }
    } catch {
      /* 非 Electron 环境跳过 */
    }
    this.settings.cookie = '';
    this.settings.wereadApiKey = '';
    this.settings.loginProfile = undefined;
    // 网页登录态是上一次实测结果，登出后必须回到「未检测」，否则界面还显示正常
    this.settings.webLoginOk = undefined;
    this.settings.webLoginAt = undefined;
    this.settings.webLoginMsg = '';
    // 切换账号必须清掉旧账号的书架/勾选/文章索引，否则两个账号数据混在一个视图里
    this.settings.accounts = [];
    this.settings.shelfAccounts = [];
    this.state.discovered = {};
    this.state.read = {};
    this.state.summaries = {};
    this.state.processed = {};
    try {
      const avatarPath = `${this.manifest.dir}/avatar.jpg`;
      if (await this.app.vault.adapter.exists(avatarPath)) await this.app.vault.adapter.remove(avatarPath);
    } catch {
      /* noop */
    }
    await this.saveAll();
    this.renderStatus();
    this.notifyViews(); // 立刻清掉旧账号的头像 / 昵称 / 订阅列表残影
    this.emitWatch();
  }

  /** 退出登录（命令面板 / 顶部按钮 / 设置页共用）：清干净后让用户自己重新扫码 */
  async logoutAccount(): Promise<void> {
    if (this.loginState() === 'none') {
      new Notice('当前没有登录微信读书账号');
      return;
    }
    await this.logout();
    new Notice('已退出微信读书账号：本机登录态、书架缓存、头像都已清空，可以重新扫码登录了。', 8000);
  }

  /** 扫码登录（命令 / 设置页统一入口）：走纯 HTTP 协议，不依赖内嵌 webview */
  startIframeLogin(): void {
    this.startQrLogin();
  }

  /**
   * 旧的内嵌 webview 登录（保留作应急方案）：
   * Obsidian 把 window.open 转给了系统浏览器（setWindowOpenHandler），
   * 所以扫码窗口必须用同源 iframe —— cookie 落在 Obsidian 的 defaultSession，
   * 之后 requestUrl 自动携带，不需要读取 cookie（绕过 electron.remote 被移除的问题）。
   */
  startWebviewLoginLegacy(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText('扫码登录微信读书');
    const box = modal.contentEl.createDiv('wmc-login-iframe-box');
    box.createDiv({
      cls: 'wmc-login-tip',
      text: '在下面窗口里用微信扫码。检测到登录态后会自动关闭并同步书架，不需要复制任何东西。',
    });
    const status = box.createDiv({ cls: 'wmc-login-status', text: '等待扫码…' });
    // 必须用 webview 而不是 iframe：iframe 跨域读不到 document.cookie，
    // webview 是独立 webContents，executeJavaScript 能在目标页上下文里取 cookie。
    let wv: WebviewElement | null = null;
    try {
      wv = createWebviewElement();
      wv.className = 'wmc-login-frame';
      wv.setAttribute('src', 'https://weread.qq.com/');
      wv.setAttribute('allowpopups', 'false');
      box.appendChild(wv);
    } catch {
      wv = null;
    }
    if (!wv) {
      const frame = box.createEl('iframe', { cls: 'wmc-login-frame' });
      frame.setAttr('src', 'https://weread.qq.com/');
    }
    this.loginPolling = true;
    modal.open();

    // 手动兜底：探测卡住时用户可点这个立刻重试
    let probeNow: (() => Promise<boolean>) | null = null;
    const manual = box.createEl('button', { cls: 'wmc-hero-btn', text: '我已经扫码了，立即同步' });
    manual.addEventListener('click', () => {
      void (async () => {
        status.setText('正在检测登录态…');
        if (probeNow && (await probeNow())) return;
        status.setText('还没检测到登录态，再等一下或重扫一次');
      })();
    });

    let finished = false;
    const finish = async (): Promise<boolean> => {
      if (finished) return true;
      let ok = false;
      // ① webview 内直接读 document.cookie —— 最可靠，能拿到 wr_skey/wr_vid/wr_gid
      if (wv && typeof wv.executeJavaScript === 'function') {
        try {
          const raw = await wv.executeJavaScript('document.cookie');
          const str = typeof raw === 'string' ? raw : '';
          if (/wr_skey=/.test(str) && /wr_vid=/.test(str)) {
            this.settings.cookie = normalizeCookie(str);
            this.settings.useSession = false;
            ok = true;
          }
        } catch {
          /* 页面还没加载完，下次再试 */
        }
      }
      // ② 老环境能直接读 cookie
      if (!ok) {
        const ck = await this.tryReadSessionCookie();
        if (ck && checkCookie(ck).ok) {
          this.settings.cookie = normalizeCookie(ck);
          this.settings.useSession = false;
          ok = true;
        }
      }
      // ③ 最后兜底：session 探测
      if (!ok && (await this.probeSessionLogin())) {
        this.settings.useSession = true;
        ok = true;
      }
      if (!ok) return false;

      finished = true;
      this.loginPolling = false;
      status.setText('登录成功，正在同步…');
      try {
        modal.close(); // 先关窗，用户在设置页就能看到信息卡刷新
      } catch {
        /* 用户已手动关闭 */
      }
      const key = await this.refreshApiKey().catch(() => null);
      const prof = await this.refreshProfile().catch(() => null);
      const n = await this.syncAccountsFromShelf().catch(() => 0);
      const web = await this.checkWebLogin().catch(() => ({ ok: false, msg: '未知' }));
      this.notifyViews();
      this.renderStatus();
      this.emitWatch();
      new Notice(
        `登录成功${prof?.name ? `：${prof.name}` : ''}${key ? ' · 已换出官方 Key' : ''}${
          n ? ` · 书架 ${n} 个` : ''
        }${web.ok ? ' · 列表可用' : ` · 列表仍不通：${web.msg}`}`,
        web.ok ? 10000 : 16000,
      );
      return true;
    };
    probeNow = finish;

    // 微信读书登录成功后会跳转页面 → iframe 触发 load，立刻探测一次
    if (wv && typeof wv.addEventListener === 'function') {
      wv.addEventListener('dom-ready', () => {
        void finish();
      });
      wv.addEventListener('did-navigate', () => {
        void finish();
      });
      wv.addEventListener('did-navigate-in-page', () => {
        void finish();
      });
    }

    void (async () => {
      const t0 = Date.now();
      let tries = 0;
      while (this.loginPolling && Date.now() - t0 < 6 * 60 * 1000) {
        await sleep(1800);
        tries++;
        if (finished) return;
        if (tries % 3 === 0) status.setText(`等待扫码…（已检测 ${tries} 次，登录后会自动关闭）`);
        if (await finish()) return;
      }
      this.loginPolling = false;
      try {
        modal.close();
      } catch {
        /* noop */
      }
      new Notice('等待扫码超时（6 分钟），已关闭窗口', 8000);
    })();
  }

  /** 启动自检：没有 cookie 但 Obsidian session 里已登录 → 自动切 session 模式 */
  async autoDetectSession(): Promise<void> {
    if (this.hasLogin()) return;
    try {
      if (!(await this.probeSessionLogin())) return;
      this.settings.useSession = true;
      await this.saveAll();
      await this.refreshProfile().catch(() => null);
      await this.syncAccountsFromShelf();
      this.notifyViews();
      this.renderStatus();
      new Notice('已自动识别 Obsidian 内的微信读书登录态', 8000);
    } catch {
      /* 静默 */
    }
  }

  /** 实测「网页登录态」是否真的能用（cookie 字段齐全 ≠ 服务端认账） */
  async checkWebLogin(): Promise<{ ok: boolean; msg: string }> {
    const acc = this.settings.accounts[0] || this.settings.shelfAccounts[0];
    if (!acc?.bookId) return { ok: false, msg: '还没有可测的公众号' };
    try {
      const client = new WereadClient(this.http, normalizeCookie(this.settings.cookie || ''));
      const items = await client.listArticles(acc.bookId, 0);
      const ok = items.length > 0;
      this.settings.webLoginOk = ok;
      this.settings.webLoginAt = Date.now();
      this.settings.webLoginMsg = ok ? `列表正常（${items.length} 条）` : '列表返回空';
      await this.saveAll();
      return { ok, msg: this.settings.webLoginMsg };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.settings.webLoginOk = false;
      this.settings.webLoginAt = Date.now();
      this.settings.webLoginMsg = msg;
      await this.saveAll();
      return { ok: false, msg };
    }
  }

  /** 网页登录态的一行摘要（给设置页/状态条用） */
  webLoginSummary(): string {
    if (this.settings.webLoginOk === undefined) return '未检测';
    const mins = this.settings.webLoginAt ? Math.round((Date.now() - this.settings.webLoginAt) / 60000) : 0;
    if (this.settings.webLoginOk) return `正常（${mins} 分钟前检测）`;
    return `已失效：${(this.settings.webLoginMsg || '').slice(0, 40)}`;
  }

  /** 是否具备可用登录态：session 模式，或手动 Cookie 完整 */
  hasLogin(): boolean {
    if (this.settings.useSession) return true;
    return checkCookie(normalizeCookie(this.settings.cookie || '')).ok;
  }

  /**
   * 保存 cookie 后用**真实列表接口**再验一次。
   * 「格式完整」不等于「服务端认」——旧版本只判字段存在，于是「四项齐、值全空」的
   * 坏 cookie 在界面上显示已登录，一抓就 -2012。这里把判定升级为「格式 + 接口」双判。
   * @param notify true = 用户主动保存，用 Notice 汇报；false = 后台轮询，只更新状态
   */
  async verifyCookieLive(notify = false): Promise<AccessProbe | null> {
    const ck = normalizeCookie(this.settings.cookie || '');
    if (!ck) return null;
    const stamp = Date.now();
    const chk = checkCookie(ck);

    if (!chk.ok) {
      this.settings.webLoginOk = false;
      this.settings.webLoginAt = stamp;
      this.settings.webLoginMsg = `登录信息不完整：${describeCookieCheck(chk)}（需重新扫码）`;
      await this.saveAll();
      this.notifyViews();
      if (notify) new Notice(this.settings.webLoginMsg, 12000);
      return null;
    }

    const probe = await probeAccess(this.http, ck).catch(() => null);
    if (!probe) {
      this.settings.webLoginOk = false;
      this.settings.webLoginAt = stamp;
      this.settings.webLoginMsg = '接口探针无响应（网络超时），稍后重试';
      await this.saveAll();
      if (notify) new Notice('没连上微信读书接口，稍后再试', 10000);
      return null;
    }

    this.settings.webLoginOk = probe.verdict === 'ok';
    this.settings.webLoginAt = stamp;
    this.settings.webLoginMsg = probe.hint;
    await this.saveAll();
    this.notifyViews();
    if (notify) {
      new Notice(
        probe.verdict === 'ok'
          ? `登录态已验证可用${probe.account ? `：${probe.account}` : ''}`
          : `登录态存疑：${probe.hint}`,
        probe.verdict === 'ok' ? 8000 : 14000,
      );
    }
    return probe;
  }

  loginState(): 'none' | 'cookie' | 'full' {
    const ck = checkCookie(this.settings.cookie || '');
    const hasKey = /^wrk-/.test(this.settings.wereadApiKey || '');
    if (ck.ok && hasKey) return 'full';
    if (ck.ok || hasKey) return 'cookie';
    return 'none';
  }

  /** 用当前登录态换官方 API Key */
  async refreshApiKey(): Promise<string | null> {
    const ck = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) return null;
    const key = await fetchApiKey(this.http, ck);
    if (key) {
      this.settings.wereadApiKey = key;
      await this.saveAll();
    }
    return key;
  }

  /** 诊断登录态：把探测结果写进插件目录，便于定位 cookie/session 问题 */
  async diagnoseLogin(): Promise<string> {
    const out: string[] = [];
    const stamp = new Date().toLocaleString('zh-CN');
    out.push(`# 登录态诊断 ${stamp}`);

    // 1) 插件里存的 cookie
    const ck = normalizeCookie(this.settings.cookie || '');
    const vid = (ck.split(';').map((x) => x.trim()).find((x) => x.startsWith('wr_vid=')) || '').slice(7);
    out.push(`\n[1] 插件 cookie：${ck ? ck.split(';').length + ' 项' : '空'} · wr_vid=${vid || '(无)'}`);
    out.push(`    checkCookie: ${JSON.stringify(checkCookie(ck))}`);
    out.push(`    loginProfile: ${JSON.stringify(this.settings.loginProfile || null)}`);

    // 2) Electron 能力探测
    out.push('\n[2] Electron 能力：');
    try {
      // 运行时按需加载 node/electron 模块
      const req = nodeRequire();
      out.push(`    require 存在: ${!!req}`);
      const el = req ? req<Record<string, unknown>>('electron') : null;
      out.push(`    require('electron'): ${el ? Object.keys(el).slice(0, 12).join(',') : 'null'}`);
      out.push(`    electron.remote: ${el?.remote ? 'ok' : 'null'}`);
      try {
        const r2 = req ? req<Record<string, unknown>>('@electron/remote') : null;
        out.push(`    @electron/remote: ${r2 ? 'ok' : 'null'}`);
      } catch (e) {
        out.push(`    @electron/remote: 抛错 ${String(e).slice(0, 60)}`);
      }
    } catch (e) {
      out.push(`    探测异常: ${String(e).slice(0, 80)}`);
    }

    // 3) 带着插件 cookie 请求
    const acc = this.settings.shelfAccounts[0] || this.settings.accounts[0];
    if (acc?.bookId) {
      const url = `https://weread.qq.com/web/mp/articles?bookId=${acc.bookId}&offset=0`;
      const UA = WEREAD_UA;
      out.push(`\n[3] 测号：${acc.name} ${acc.bookId}`);
      try {
        const a = await this.rawHttp(url, { Cookie: ck, 'User-Agent': UA, Referer: 'https://weread.qq.com/' });
        out.push(`    带 Cookie: HTTP ${a.status} · ${a.text.slice(0, 120)}`);
      } catch (e) {
        out.push(`    带 Cookie 异常: ${String(e).slice(0, 80)}`);
      }
      try {
        const b = await this.rawHttp(url, { 'User-Agent': UA, Referer: 'https://weread.qq.com/' });
        out.push(`    不带 Cookie(session): HTTP ${b.status} · ${b.text.slice(0, 120)}`);
      } catch (e) {
        out.push(`    不带 Cookie 异常: ${String(e).slice(0, 80)}`);
      }
    }

    // 4) 用户资料端点逐个试
    out.push('\n[4] 用户资料端点：');
    const UA2 = WEREAD_UA;
    const cands = [
      `https://weread.qq.com/web/user?userVid=${vid}`,
      'https://weread.qq.com/api/user/info',
      'https://weread.qq.com/api/user/profile',
      'https://weread.qq.com/web/user?userVid=0',
    ];
    for (const u of cands) {
      for (const withCookie of [true, false]) {
        try {
          const h: Record<string, string> = { 'User-Agent': UA2, Referer: 'https://weread.qq.com/', Accept: 'application/json' };
          if (withCookie) h.Cookie = ck;
          const r = await this.rawHttp(u, h);
          out.push(`    ${u.replace('https://weread.qq.com', '')} ${withCookie ? '(cookie)' : '(session)'}: ${r.status} ${r.text.slice(0, 90)}`);
        } catch (e) {
          out.push(`    ${u.replace('https://weread.qq.com', '')}: 异常 ${String(e).slice(0, 50)}`);
        }
      }
    }

    const text = out.join('\n');
    try {
      await this.app.vault.adapter.write(`${this.manifest.dir}/诊断.txt`, text);
    } catch {
      /* 写失败不阻塞 */
    }
    new Notice('诊断已写入插件目录 诊断.txt', 8000);
    return text;
  }

  /** 拉登录用户资料（昵称 / 头像 / VID / 简介） */
  async refreshProfile(): Promise<LoginProfile | null> {
    const ck = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) return null;
    let p = await fetchProfile(this.http, ck).catch(() => null);
    if (!p || !p.name) {
      // 切换账号后旧 cookie 的 vid 已失效，改用不依赖 vid 的端点
      p = await fetchCurrentUser(this.http, ck).catch(() => null);
    }
    if (p) {
      // 头像落地存插件目录，避免外链 CDN 被拦导致空白
      if (p.avatar) {
        try {
          const r = await requestUrl({
            url: p.avatar,
            method: 'GET',
            throw: false,
            headers: { 'User-Agent': WEREAD_UA },
          });
          if (r.status === 200 && r.arrayBuffer.byteLength > 300) {
            const path = `${this.manifest.dir}/avatar.jpg`;
            await this.app.vault.adapter.writeBinary(path, r.arrayBuffer);
            p.avatarPath = path;
          }
        } catch {
          /* 头像下载失败不阻塞登录 */
        }
      }
      this.settings.loginProfile = p;
      await this.saveAll();
    }
    return p;
  }

  /** 从官方书架同步公众号清单 */
  async syncAccountsFromShelf(): Promise<number> {
    if (!this.settings.wereadApiKey) {
      const k = await this.refreshApiKey();
      if (!k) {
        new Notice('需要先登录（扫码后再同步书架）');
        return 0;
      }
    }
    try {
      const api = new WereadAgentApi(this.llmHttp, this.settings.wereadApiKey);
      const list = await api.mpAccounts();
      if (!list.length) return 0;
      this.settings.shelfAccounts = list;
      // 首次同步（还没选过）时默认勾前 10 个，之后尊重用户勾选
      if (!this.settings.accounts.length) this.settings.accounts = list.slice(0, 10);
      await this.saveAll();
      return list.length;
    } catch (e) {
      new Notice(`同步书架失败：${e instanceof Error ? e.message : String(e)}`, 8000);
      return 0;
    }
  }

  cancelQrLogin(): void {
    this.loginPolling = false;
  }

  /* -------------------------------- watching ------------------------------- */

  startWatch(notify: boolean) {
    const min = Math.max(MIN_INTERVAL, Math.round(this.settings.intervalMin || 30));
    this.stopWatch(false);
    this.state.watchSince = Date.now();
    this.timer = window.setInterval(() => void this.runOnce(false), min * 60 * 1000);
    this.registerInterval(this.timer);
    this.watch.running = true;
    this.watch.nextRunAt = Date.now() + min * 60 * 1000;
    this.pushLog(`自动更新已开启 · 每 ${min} 分钟看一次`, 'ok');
    this.emitWatch();
    this.renderStatus();
    if (notify) new Notice(`自动盯采已开启：每 ${min} 分钟一轮`);
  }

  stopWatch(notify: boolean) {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.watch.running = false;
    this.watch.nextRunAt = undefined;
    this.pushLog('自动更新已暂停', 'warn');
    this.emitWatch();
    this.renderStatus();
    if (notify) new Notice('自动盯采已停止');
  }

  private renderStatus() {
    if (!this.statusEl) return;
    const last = this.state.lastRun;
    const watching = this.timer !== null;
    const icon = watching ? '●' : '○';
    const tail = last
      ? last.error
        ? `错误：${last.error.slice(0, 22)}`
        : `+${last.written}/${last.found}`
      : '未运行';
    this.statusEl.setText(`微信读书 ${icon} ${tail}`);
  }

  /* --------------------------------- fetch --------------------------------- */

  async runOnce(manual: boolean) {
    if (this.running) {
      if (manual) new Notice('上一轮还在跑');
      return;
    }
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!cookie) {
      if (manual) new Notice('还没登录：设置里粘贴 cookie 或点击「打开登录窗口」');
      return;
    }
    const chk = checkCookie(cookie);
    if (!chk.ok) {
      if (manual) new Notice(`Cookie 不完整，缺：${chk.missing.join(', ')}（缺 wr_gid 会报 -2012）`, 8000);
    }
    const accounts = this.settings.accounts.filter((a) => String(a.bookId || '').toUpperCase().startsWith('MP_WXS_'));
    if (!accounts.length) {
      if (manual) new Notice('还没有公众号：设置里添加 bookid（MP_WXS_ 开头）');
      return;
    }

    // 限频冷却期：一律不发列表请求，避免越试越锁
    const coolLeft = (this.state.listCooldownUntil ?? 0) - Date.now();
    if (coolLeft > 0) {
      const mins = Math.ceil(coolLeft / 60000);
      const msg = `列表接口还在限频冷却中，约 ${mins} 分钟后可再试（-2014）`;
      this.pushLog(msg, 'err');
      if (manual) new Notice(msg, 9000);
      return;
    }

    // 本轮只检查一部分公众号（游标轮转），总量 27 个号也不会一次全拉
    const perRun = Math.max(1, Math.min(accounts.length, this.settings.maxAccountsPerRun ?? 5));
    const cursor = this.state.accountCursor ?? 0;
    const batch: AccountRef[] = [];
    for (let i = 0; i < perRun; i++) batch.push(accounts[(cursor + i) % accounts.length]);
    this.state.accountCursor = (cursor + batch.length) % accounts.length;

    this.running = true;
    this.watch.busy = true;
    this.watch.phase = 'list';
    this.watch.accountIndex = 0;
    this.watch.accountTotal = batch.length;
    this.watch.found = 0;
    this.watch.written = 0;
    this.watch.skipped = 0;
    this.watch.lastError = undefined;
    this.pushLog(`开始更新 · 本轮检查 ${batch.length}/${accounts.length} 个公众号`);
    this.emitWatch();
    const client = new WereadClient(this.http, cookie);
    let found = 0;
    let written = 0;
    let skipped = 0;
    let riskHit = false;

    try {
      // ① 收集新条目（按号轮转，保证公平）
      const queueByAccount: Array<{ acc: AccountRef; items: ArticleItem[] }> = [];
      for (const acc of batch) {
        this.watch.account = acc.name;
        this.watch.accountIndex++;
        this.emitWatch();
        try {
          const items = await client.listArticlesPages(acc.bookId, Math.max(1, this.settings.pages));
          const fresh = items.filter((it) => !this.state.processed[it.reviewId]);
          found += fresh.length;
          this.watch.found = found;
          // 记入发现清单，供列表页展示（含未归档条目）；封面顺手本地化，防外链被拦
          if (!this.state.discovered) this.state.discovered = {};
          for (const it of items) {
            if (!this.state.discovered[it.reviewId]) {
              const entry: DiscoveredEntry = {
                account: acc.name,
                title: it.title,
                time: it.time,
                readNum: it.readNum,
                likeNum: it.likeNum,
                picUrl: it.picUrl,
                digest: it.digest,
              };
              this.state.discovered[it.reviewId] = entry;
              if (it.picUrl && this.settings.downloadImages) {
                try {
                  const buf = await client.fetchImage(it.picUrl);
                  const ext = guessExt(buf);
                  const cdir = normalizePath(`${this.settings.outputDir}/assets/covers`);
                  await this.ensureFolder(cdir);
                  const rel = normalizePath(`${cdir}/${it.reviewId}.${ext}`);
                  await this.app.vault.adapter.writeBinary(rel, buf);
                  entry.localCover = rel;
                } catch {
                  /* 封面失败不阻塞列表 */
                }
                await sleep(250);
              }
            }
          }
          queueByAccount.push({ acc, items: fresh.slice(0, this.settings.maxPerAccount) });
        } catch (e) {
          if (e instanceof RiskError) throw e;
          skipped++;
        }
        await sleep(this.settings.delayListMs);
      }

      // ② 轮转落盘
      const queue: Array<{ acc: AccountRef; item: ArticleItem }> = [];
      let round = 0;
      while (queue.length < this.settings.maxPerRun) {
        let added = 0;
        for (const g of queueByAccount) {
          const it = g.items[round];
          if (it) {
            queue.push({ acc: g.acc, item: it });
            added++;
            if (queue.length >= this.settings.maxPerRun) break;
          }
        }
        if (!added) break;
        round++;
      }

      for (const job of queue) {
        if (riskHit) break;
        this.watch.phase = 'fetch';
        this.watch.queueTotal = queue.length;
        this.watch.account = job.acc.name;
        this.emitWatch();
        try {
          const ok = await this.fetchOne(client, job.acc, job.item);
          if (ok) {
            written++;
            this.watch.written = written;
          } else {
            skipped++;
            this.watch.skipped = skipped;
          }
          this.emitWatch();
        } catch (e) {
          if (e instanceof RiskError) {
            riskHit = true;
            this.watch.lastError = '风控熔断';
            this.watch.phase = 'cooldown';
            this.pushLog(`命中风控 ${e.message}，本轮停止`, 'err');
            this.emitWatch();
            new Notice(`命中风控 ${e.message}：本轮立即停止（不做重试）`, 10000);
            break;
          }
          skipped++;
          this.watch.skipped = skipped;
        }
        await sleep(this.settings.delayContentMs);
      }

      this.state.lastRun = { at: Date.now(), found, written, skipped, error: riskHit ? '风控熔断' : undefined };
      // 这一轮跑通了说明限频已解除，清掉冷却与退避计数
      if (!riskHit) {
        this.state.listCooldownHits = 0;
        this.state.listCooldownUntil = 0;
      }
      await this.saveAll();
      if (manual) {
        new Notice(`抓取完成：发现 ${found} 篇新文，落盘 ${written} 篇${skipped ? `，跳过 ${skipped}` : ''}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.state.lastRun = { at: Date.now(), found, written, skipped, error: msg };
      this.watch.lastError = msg.slice(0, 60);
      this.watch.phase = 'cooldown';
      this.pushLog(`抓取中断：${msg}`, 'err');
      // -2014 是接口级限频：记冷却时间 + 指数退避（2h → 4h → 8h → 16h → 24h 封顶）。
      // 实测 30 分钟不够用，所以起点定在 2 小时，避免用户反复重试把窗口越推越长。
      if (e instanceof RiskError && e.code === -2014) {
        const hits = (this.state.listCooldownHits ?? 0) + 1;
        const hours = Math.min(24, 2 ** hits);
        this.state.listCooldownHits = hits;
        this.state.listCooldownUntil = Date.now() + hours * 3600_000;
        const until = new Date(this.state.listCooldownUntil).toLocaleString();
        this.pushLog(`列表接口被限频，冷却到 ${until}（第 ${hits} 次，${hours} 小时）`, 'err');
        new Notice(`列表接口限频（-2014）\n已暂停到 ${until}\n期间不会发任何列表请求`, 12000);
      }
      await this.saveAll();
      if (!(e instanceof RiskError && e.code === -2014)) new Notice(`抓取中断：${msg}`);
    } finally {
      this.running = false;
      this.watch.busy = false;
      if (this.watch.phase !== 'cooldown') this.watch.phase = 'done';
      this.watch.lastRunAt = Date.now();
      const min = Math.max(MIN_INTERVAL, Math.round(this.settings.intervalMin || 30));
      this.watch.nextRunAt = this.timer !== null ? Date.now() + min * 60 * 1000 : undefined;
      this.pushLog(written > 0 ? `这一轮收了 ${written} 篇新文章` : '这一轮没有新文章', written > 0 ? 'ok' : 'info');
      this.emitWatch();
      this.renderStatus();
      this.notifyViews();
    }
  }

  private async fetchOne(client: WereadClient, acc: AccountRef, item: ArticleItem): Promise<'written' | 'exists' | 'empty'> {
    const html = await this.loadContent(client, item.reviewId);
    // 微信读书不提供公众号原网页地址给读者，但正文 HTML 的 og:url 就是原文本身。
    // 抓到就记住：笔记里给「微信中可打开」的原文链接，侧栏「原文」也用它。
    const mpUrl = extractMpOriginalUrl(html);
    if (mpUrl) {
      if (!this.state.mpUrls) this.state.mpUrls = {};
      if (this.state.mpUrls[item.reviewId] !== mpUrl) this.state.mpUrls[item.reviewId] = mpUrl;
      const rec = this.state.discovered?.[item.reviewId];
      if (rec && rec.mpUrl !== mpUrl) rec.mpUrl = mpUrl;
    }
    // 只解析一次：之前连写两遍，3.5MB HTML 白解析一次
    const parsed = htmlToMarkdown(html);
    const { images, media } = parsed;
    let { markdown } = parsed;

    // 图片笔记（小绿书）：正文由前端 JS 渲染，HTML 里没有 js_content。
    // 只有封面图 + 摘要可用 —— 用它们生成一篇「图片笔记」而不是判空丢弃。
    if (!markdown.trim() && !images.length && !media.length) {
      if (item.picUrl || item.digest || mpUrl) {
        const bits: string[] = [];
        bits.push(
          mpUrl
            ? '> 这篇没有可提取的正文（微信读书只存了封面/摘要，正文由前端渲染）。点下面的公众号原文看全文。'
            : '> 这篇没有可提取的正文，也没有可用的原文地址。',
        );
        if (item.digest) bits.push('', item.digest);
        if (mpUrl) bits.push('', `[在微信中打开公众号原文](${mpUrl})`);
        markdown = bits.join('\n');
        if (item.picUrl && !images.length) images.push({ src: item.picUrl } as never);
      } else {
        return 'empty';
      }
    }

    const base = safeFileName(item.title || '(无标题)');
    const dir = normalizePath(`${this.settings.outputDir}/${safeFileName(acc.name)}`);
    const assetDir = normalizePath(`${this.settings.outputDir}/assets/${base}`);
    await this.ensureFolder(dir);

    // 图片本地化：并发 5 张。图片在 mmbiz CDN 上，不受公众号列表接口限流约束，
    // 之前每张之间还 sleep(delayContentMs/2)=2.25s，8 张图要白等 18 秒。
    const localPaths: string[] = [];
    if (this.settings.downloadImages && images.length) {
      await this.ensureFolder(assetDir);
      await mapLimit(images, 5, async (img, i) => {
        try {
          const buf = await client.fetchImage(img.src);
          const ext = guessExt(buf);
          const rel = normalizePath(`${assetDir}/img-${i + 1}.${ext}`);
          await this.app.vault.adapter.writeBinary(rel, buf);
          localPaths[i] = normalizePath(`../assets/${base}/img-${i + 1}.${ext}`);
        } catch {
          localPaths[i] = '';
        }
      });
    }

    // 音视频：尽力解析直链 → 本地化 + Obsidian 播放器标签；失败降级为原站链接
    const mediaRefs: Array<{ type: 'audio' | 'video'; path?: string; url: string; name?: string }> = [];
    if (media.length) {
      await this.ensureFolder(assetDir);
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        let url = m.direct || m.url;
        if (!m.direct && m.type === 'video') url = await client.resolveVideo(url);
        const direct = /\.(mp4|m3u8|mp3|m4a|aac|wav)(\?|$)/i.test(url);
        let saved = false;
        if (this.settings.downloadImages && direct) {
          try {
            const buf = await client.fetchMedia(url);
            const mb = buf.byteLength / 1048576;
            if (mb > this.settings.maxMediaMB) {
              new Notice(
                `${m.type === 'video' ? '视频' : '音频'} ${mb.toFixed(0)}MB 超过上限 ${this.settings.maxMediaMB}MB，改为保留原链接`,
                7000,
              );
              throw new Error('oversize');
            }
            const ext = m.type === 'video' ? 'mp4' : url.match(/\.(mp3|m4a|aac|wav)/i)?.[1] || 'mp3';
            const rel = normalizePath(`${assetDir}/media-${i + 1}.${ext}`);
            await this.app.vault.adapter.writeBinary(rel, buf);
            mediaRefs.push({ ...m, url, path: normalizePath(`../assets/${base}/media-${i + 1}.${ext}`) });
            saved = true;
          } catch {
            /* 落到降级分支 */
          }
          // CDN 直链下载，不属于公众号接口限流通道：原来每段 sleep 4.5s 纯属白等
          await sleep(200);
        }
        if (!saved) mediaRefs.push({ ...m, url });
      }
    }

    let bodyMd = replaceImagePlaceholders(markdown, localPaths);
    if (media.length) bodyMd = replaceMediaPlaceholders(bodyMd, mediaRefs);
    const path = normalizePath(`${dir}/${base}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return 'exists'; // 幂等：已存在算已完成，不算空

    const published = fmtDate(item.time);
    const fmTags = ['剪藏', '微信读书公众号'];
    const note = [
      '---',
      `title: "${(item.title || '').replace(/"/g, '\\"')}"`,
      `date: ${ymdNow()}`,
      `source: "${mpUrl || `weread://${item.reviewId}`}"`,
      `reviewId: "${item.reviewId}"`,
      mpUrl ? `mp_url: "${mpUrl.replace(/"/g, '\\"')}"` : null,
      `author: "${acc.name.replace(/"/g, '\\"')}"`,
      `author_org: "${acc.name.replace(/"/g, '\\"')}（微信读书）"`,
      'tags:',
      ...fmTags.map((t) => `  - ${t}`),
      item.readNum !== undefined ? `readNum: ${item.readNum}` : null,
      item.likeNum !== undefined ? `likeNum: ${item.likeNum}` : null,
      `published: ${published}`,
      `created: ${ymdNow()}`,
      '---',
      '',
      `# ${item.title || '(无标题)'}`,
      '',
      `> 来源：微信读书 · ${acc.name}${item.readNum !== undefined ? `｜阅读 ${item.readNum}` : ''}${
        item.likeNum !== undefined ? ` · 赞 ${item.likeNum}` : ''
      }｜发布 ${published}`,
      '',
      mpUrl ? `[在微信中打开公众号原文](${mpUrl})` : null,
      '',
      '## 正文',
      '',
      bodyMd,
      '',
    ]
      .filter((x) => x !== null)
      .join('\n');

    await this.app.vault.create(path, note);
    this.state.processed[item.reviewId] = {
      account: acc.name,
      title: item.title,
      time: item.time,
      path,
      at: Date.now(),
    };
    return 'written';
  }

  private async ensureFolder(path: string) {
    if (!path) return;
    const segs = path.split('/');
    let cur = '';
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* 已存在/并发创建 */
        }
      }
    }
  }

  /** 单号全量历史归档：逐篇状态可观测 + 网络抖动重试 + 风控熔断 */
  /**
   * 某号的历史归档库存（读本地缓存，不耗网络）。
   * archived 用严格判据：processed 有记录【且】笔记文件仍在 vault 里。
   */
  getArchiveStats(accountName: string): { total: number; archived: number; remaining: number; known: boolean } {
    const disc = this.state.discovered || {};
    let total = 0;
    let archived = 0;
    for (const [rid, v] of Object.entries(disc)) {
      if (v.account !== accountName) continue;
      total++;
      const rec = this.state.processed?.[rid];
      if (rec?.path && this.app.vault.getAbstractFileByPath(rec.path)) archived++;
    }
    return { total, archived, remaining: Math.max(0, total - archived), known: total > 0 };
  }

  /** 归档弹窗单例：重复触发时先关旧的，避免叠出两个一模一样的窗口 */
  private bfModal: BackfillModal | null = null;

  openBackfill(preset?: string): void {
    if (this.bfModal) {
      try {
        this.bfModal.close();
      } catch {
        /* 已关闭 */
      }
      this.bfModal = null;
    }
    const m = new BackfillModal(this.app, this, preset);
    m.onClosed = () => {
      if (this.bfModal === m) this.bfModal = null;
    };
    this.bfModal = m;
    m.open();
  }

  async runBackfill(
    acc: AccountRef,
    opts: { maxItems: number; fromDate: string; speed: 'safe' | 'slow'; only?: string[]; cached?: boolean },
    onProgress: (p: BfProgress) => void,
    signal: { stop: boolean },
  ): Promise<BfResult> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!this.hasLogin()) return { written: 0, skipped: 0, failed: 0, stopped: true, error: '登录态无效，请重新扫码', items: [] };
    const client = new WereadClient(this.http, cookie);
    const T =
      opts.speed === 'slow'
        ? { list: 3000, content: 6000, every: 10, rest: 120000 }
        : { list: 1200, content: 2500, every: 15, rest: 60000 };
    const fromTs = opts.fromDate ? Math.floor(new Date(`${opts.fromDate}T00:00:00`).getTime() / 1000) : 0;

    // ① 拿列表：默认用本地缓存（存量固定），需要时才翻网络
    const seen = new Set<string>();
    const list: ArticleItem[] = [];
    if (opts.cached) {
      const disc = this.state.discovered || {};
      for (const [rid, v] of Object.entries(disc)) {
        if (v.account !== acc.name) continue;
        if (seen.has(rid)) continue;
        seen.add(rid);
        list.push({
          reviewId: rid,
          title: v.title,
          time: v.time,
          readNum: v.readNum,
          likeNum: v.likeNum,
          picUrl: v.picUrl,
          mpName: acc.name,
        });
      }
      list.sort((a, b) => (b.time || 0) - (a.time || 0));
      onProgress({
        phase: 'list',
        done: 1,
        total: 1,
        written: 0,
        detail: `用本地缓存 · ${list.length} 篇（不耗网络）`,
        items: [],
      });
    }
    const maxPages = opts.maxItems > 0 ? Math.ceil(opts.maxItems / 20) + 3 : 300;
    for (let p = 0; opts.cached ? false : p < maxPages; p++) {
      if (signal.stop) break;
      const items = await client.listArticles(acc.bookId, p * 20);
      if (!items.length) break;
      let added = 0;
      for (const it of items) {
        if (seen.has(it.reviewId)) continue;
        seen.add(it.reviewId);
        if (fromTs && it.time && it.time < fromTs) continue;
        list.push(it);
        added++;
      }
      onProgress({
        phase: 'list',
        done: p + 1,
        total: maxPages,
        written: 0,
        detail: `已翻 ${p + 1} 页 · 累计 ${list.length} 篇`,
        items: [],
      });
      if (added === 0) break;
      await sleep(T.list);
    }

    // ② 逐篇任务表（已归档的直接标出来）
    const only = opts.only && opts.only.length ? new Set(opts.only) : null;
    const scope = only ? list.filter((a) => only.has(a.reviewId)) : list;
    const tasks: BfItem[] = scope.map((it) => {
      const rec = this.state.processed[it.reviewId];
      // 光有 processed 记录不算数：笔记文件必须真的还在（用户可能删过/移动过）
      const fileOk = !!(rec && rec.path && this.app.vault.getAbstractFileByPath(rec.path));
      const done = fileOk && !only;
      return {
        reviewId: it.reviewId,
        title: it.title,
        state: done ? 'skipped' : 'pending',
        note: done ? '已归档' : undefined,
      };
    });
    const todo = tasks
      .filter((t) => t.state === 'pending')
      .slice(0, opts.maxItems > 0 ? opts.maxItems : tasks.length);
    const itemMap = new Map(scope.map((it) => [it.reviewId, it]));
    const emit = (done: number, written: number) => {
      const archivedAll = tasks.filter((t) => t.state === 'done' || t.state === 'skipped').length;
      onProgress({
        phase: 'fetch',
        done,
        total: todo.length,
        written,
        items: tasks,
        totalAll: tasks.length,
        archivedAll,
      });
    };

    emit(0, 0);
    if (!todo.length) {
      return { written: 0, skipped: tasks.length, failed: 0, stopped: false, items: tasks };
    }

    let n = 0;
    for (const row of todo) {
      if (signal.stop) break;
      const it = itemMap.get(row.reviewId);
      if (!it) continue;
      n++;
      row.state = 'running';
      emit(n - 1, tasks.filter((t) => t.state === 'done').length);
      const t0 = Date.now();
      let res: 'written' | 'exists' | 'empty' | '' = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          res = await this.fetchOne(client, acc, it);
          break;
        } catch (e) {
          if (e instanceof RiskError) {
            row.state = 'failed';
            row.note = '命中风控，已停止';
            row.ms = Date.now() - t0;
            emit(n, tasks.filter((t) => t.state === 'done').length);
            await this.saveAll();
            return {
              written: tasks.filter((t) => t.state === 'done').length,
              skipped: 0,
              failed: 1,
              stopped: true,
              error: `命中风控 ${e.message}：已停止，不要立刻重试`,
              items: tasks,
            };
          }
          row.tries = attempt;
          if (attempt < 2) {
            row.note = '网络抖动 · 重试 1/2';
            emit(n - 1, tasks.filter((t) => t.state === 'done').length);
            await sleep(2500);
          } else {
            row.state = 'failed';
            row.note = (e instanceof Error ? e.message : String(e)).slice(0, 60);
          }
        }
      }
      row.ms = Date.now() - t0;
      if (res === 'written') {
        row.state = 'done';
        row.note = undefined;
      } else if (res === 'exists') {
        row.state = 'skipped';
        row.note = '文件已存在';
      } else if (row.state !== 'failed') {
        row.state = 'skipped';
        row.note = '无正文（疑似已删除）';
      }
      emit(n, tasks.filter((t) => t.state === 'done').length);
      if (n % T.every === 0) await sleep(T.rest);
      else await sleep(T.content);
    }
    await this.saveAll();
    return {
      written: tasks.filter((t) => t.state === 'done').length,
      skipped: tasks.filter((t) => t.state === 'skipped').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
      stopped: signal.stop,
      items: tasks,
    };
  }

  /** 用当前 cookie 探测书架号数（设置页「测试连接」用） */
  async testConnection(): Promise<string> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    const web = await this.checkWebLogin();
    if (!web.ok) {
      return `列表不通：${web.msg}｜官方 Key 仍有效（书架可读）。修法：点「重新扫码」，在**插件弹窗**里扫码（Chrome 里的登录态插件读不到）。`;
    }
    const chk = checkCookie(cookie);
    if (!chk.ok) return `Cookie 不完整，缺 ${chk.missing.join(', ')}`;
    const accounts = this.settings.accounts.filter((a) => String(a.bookId || '').toUpperCase().startsWith('MP_WXS_'));
    if (!accounts.length) return 'Cookie 格式 OK（但还没添加公众号）';
    const client = new WereadClient(this.http, cookie);
    try {
      const list = await client.listArticles(accounts[0].bookId, 0);
      return `连接正常：首个号拉到 ${list.length} 条（${list[0]?.title?.slice(0, 18) ?? '无标题'}…）`;
    } catch (e) {
      return `连接失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /* --------------------------- 列表视图 / 单篇 / AI --------------------------- */

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_WMC);
    // 优先复用主区域的视图；侧栏里的（历史遗留）一律关掉，避免"打开却出现在右边"
    const inMain = leaves.find((l) => l.getRoot() === workspace.rootSplit);
    if (inMain) {
      leaves.forEach((l) => {
        if (l !== inMain) l.detach();
      });
      const v = inMain.view as unknown as { render?: () => void };
      v?.render?.();
      void workspace.revealLeaf(inMain);
      return;
    }
    leaves.forEach((l) => l.detach());
    // 主标签页打开（对齐 qiaomu-home 的观感），不用右侧插件栏
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_WMC, active: true });
    void workspace.revealLeaf(leaf);
  }

  isWatching(): boolean {
    return this.timer !== null;
  }

  toggleWatchFromView(): void {
    if (this.timer) this.stopWatch(true);
    else this.startWatch(true);
  }

  accountNames(): string[] {
    return this.settings.accounts.map((a) => a.name || a.bookId);
  }

  markRead(reviewId: string): void {
    if (!this.state.read) this.state.read = {};
    if (!this.state.read[reviewId]) {
      this.state.read[reviewId] = Date.now();
      void this.saveAll();
    }
  }

  async readNoteBody(path: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return '';
    const md = await this.app.vault.cachedRead(f);
    const i = md.indexOf('## 正文');
    return i >= 0 ? md.slice(i + 5) : md;
  }

  /**
   * 从已归档笔记里取公众号原文地址。
   * state.discovered 里的 mpUrl 只有「抓过正文」才有，老笔记靠这条兜底，
   * 免得侧栏「原文」对已归档文章反而显示「没有地址」。
   */
  async noteMpUrl(path?: string): Promise<string> {
    if (!path) return '';
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return '';
      const md = await this.app.vault.cachedRead(f);
      const fm = /^mp_url:\s*"?([^"\n]+)"?/m.exec(md);
      if (fm && /mp\.weixin\.qq\.com/.test(fm[1])) return fm[1].trim();
      const m = /https?:\/\/mp\.weixin\.qq\.com\/s(?:\?|\/)[^\s)"'<>]*/.exec(md);
      return m ? m[0].replace(/[),.;]+$/, '') : '';
    } catch {
      return '';
    }
  }

  /**
   * 按需只取「公众号原文地址」：抓一次正文 HTML，抠出 og:url，不落盘笔记。
   * 列表接口不带原文地址（mpInfo 里只有 originalId，不是 URL），所以只能这样补；
   * 结果缓存在 state.mpUrls，同一个会话里再打开「原文」不会再请求。
   */
  async resolveMpUrl(reviewId: string): Promise<string> {
    const cached = this.state.mpUrls?.[reviewId];
    if (cached) return cached;
    if (this.mpUrlMiss.has(reviewId)) return '';
    // 侧栏可能在几毫秒内连渲两次，同一个 reviewId 只允许一个请求在飞
    const pending = this.mpUrlPending.get(reviewId);
    if (pending) return pending;
    const job = this.fetchMpUrl(reviewId).finally(() => this.mpUrlPending.delete(reviewId));
    this.mpUrlPending.set(reviewId, job);
    return job;
  }

  /** 取正文 HTML，命中近期缓存就不再发请求（3.5MB/篇，省一次就是一两秒） */
  private async loadContent(client: WereadClient, reviewId: string): Promise<string> {
    const hit = this.contentCache.get(reviewId);
    if (hit) return hit;
    const html = await client.getContentHtml(reviewId);
    this.contentCache.set(reviewId, html);
    while (this.contentCache.size > 3) {
      const oldest = this.contentCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.contentCache.delete(oldest);
    }
    return html;
  }

  private async fetchMpUrl(reviewId: string): Promise<string> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!cookie) return '';
    const client = new WereadClient(this.http, cookie);
    try {
      const html = await this.loadContent(client, reviewId);
      const url = extractMpOriginalUrl(html);
      if (!url) {
        // 视频号/已删除文章没有 og:url，记住别再反复请求
        this.mpUrlMiss.add(reviewId);
        return '';
      }
      if (!this.state.mpUrls) this.state.mpUrls = {};
      this.state.mpUrls[reviewId] = url;
      const rec = this.state.discovered?.[reviewId];
      if (rec) rec.mpUrl = url;
      this.mpUrlMiss.delete(reviewId);
      await this.saveAll();
      return url;
    } catch (e) {
      this.mpUrlMiss.add(reviewId);
      new Notice(`取原文链接失败：${e instanceof Error ? e.message : String(e)}`, 6000);
      return '';
    }
  }

  /** 列表里点「抓取并归档」走这里 */
  async archiveSingle(reviewId: string, accountName: string): Promise<boolean> {
    const acc = this.settings.accounts.find((a) => (a.name || a.bookId) === accountName);
    if (!acc) {
      new Notice('找不到该公众号配置');
      return false;
    }
    const d = this.state.discovered?.[reviewId];
    const item: ArticleItem = {
      reviewId,
      title: d?.title ?? '(无标题)',
      time: d?.time ?? Math.floor(Date.now() / 1000),
      readNum: d?.readNum,
      likeNum: d?.likeNum,
      // 必须带上：图片类文章（小绿书）没有 js_content，只能靠封面 + 摘要生成图片笔记。
      // 之前这里漏传，导致这类文章在侧栏点「抓取并归档」总是返回 empty → 显示「失败，重试」。
      picUrl: d?.picUrl,
      digest: d?.digest,
      mpName: acc.name,
    };
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!cookie) {
      new Notice('还没登录：设置里填 cookie');
      return false;
    }
    const client = new WereadClient(this.http, cookie);
    try {
      const ok = await this.fetchOne(client, acc, item);
      if (ok === 'written') await this.saveAll();
      if (ok === 'empty') {
        new Notice('这篇没有正文也没有封面（可能是已删除，或只能在微信里打开），已跳过', 6000);
        return false;
      }
      return ok === 'written' || ok === 'exists';
    } catch (e) {
      new Notice(`抓取失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** LLM 的 http 适配（requestUrl 支持 POST） */
  private llmHttp = async (url: string, headers: Record<string, string>, method = 'GET', body?: string) => {
    const r = await requestUrl({ url, method, headers, body, throw: false });
    return { status: r.status, text: r.text };
  };

  async testLLMConnection(): Promise<string> {
    try {
      return await testLLM(this.llmHttp, this.settings.llm);
    } catch (e) {
      return `失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 总结正文 → 写回笔记「## AI 摘要」（幂等） */
  async aiSummarizeNote(path: string, title: string, body: string): Promise<boolean> {
    const cfg = this.settings.llm;
    const bad = validateConfig(cfg);
    if (bad) {
      new Notice(`LLM 未配置：${bad}`);
      return false;
    }
    this.state.llmQuota = quotaToday(this.state.llmQuota, ymdNow());
    try {
      checkQuota(cfg, this.state.llmQuota);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return false;
    }

    const text = await llmSummarize(this.llmHttp, cfg, title, body);
    this.state.llmQuota.count++;
    const stamp = new Date().toLocaleString();
    const block = `\n\n## AI 摘要\n\n> ${cfg.model} · ${stamp}\n\n${text}\n`;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return false;
    const md = await this.app.vault.cachedRead(f);
    const marker = '## AI 摘要';
    const next = md.includes(marker)
      ? md.slice(0, md.indexOf(marker)).replace(/\s+$/, '') + block
      : md.replace(/\s+$/, '') + block;
    await this.app.vault.process(f, () => next);
    await this.saveAll();
    return true;
  }
}

/* -------------------------------- settings -------------------------------- */

class WMSettingTab extends PluginSettingTab {
  plugin: WereadMpCatcher;
  private accountsDraft = '';

  constructor(app: App, plugin: WereadMpCatcher) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Obsidian 1.13+ 声明式设置入口。
   * 整个设置页是手写 DOM（不用原生 Setting 行），所以用一条 render 型定义把页面接管下来：
   * 声明式 API 只负责挂载与搜索索引，视觉与交互仍走自定义设计系统。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: '微信读书公众号盯采',
        render: (setting) => {
          const host = setting.settingEl;
          host.empty();
          host.addClass('wmc-settings', 'wmc-settings-host');
          this.renderBody(host);
          return () => host.removeClass('wmc-settings', 'wmc-settings-host');
        },
      },
    ];
  }

  /** 立即重绘设置页（声明式 api 下改状态后调用） */
  private refreshUI(): void {
    this.update();
  }

  private renderBody(containerEl: HTMLElement): void {

    /* 1. 登录 */
    containerEl.createDiv({ cls: 'wmc-settings-h', text: '登录' });
    const st = this.plugin.loginState();
    const card = containerEl.createDiv('wmc-login');
    const prof = this.plugin.settings.loginProfile;
    const avatarSrc = prof?.avatarPath
      ? this.app.vault.adapter.getResourcePath(prof.avatarPath)
      : prof?.avatar;
    if (avatarSrc) {
      const img = card.createEl('img', { cls: 'wmc-login-avatar' });
      img.src = avatarSrc;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.addClass('is-broken'));
    } else {
      card.createDiv({ cls: 'wmc-login-avatar is-empty' });
    }
    card.createDiv({ cls: `wmc-login-dot is-${st}` });
    const txt = card.createDiv('wmc-login-text');
    txt.createDiv({
      cls: 'wmc-login-title',
      text: prof?.name || (st === 'full' ? '已登录' : st === 'cookie' ? '登录不完整' : '未登录'),
    });
    if (st === 'none') {
      txt.createDiv({ cls: 'wmc-login-sub', text: '扫码即可，不需要复制任何 Cookie' });
    } else {
      // 第一行：身份 + 官方 Key（长期有效，只决定书架能不能读）
      txt.createDiv({
        cls: 'wmc-login-sub',
        text: [
          prof?.vid ? `VID ${prof.vid}` : '',
          st === 'full' ? '官方 Key 有效' : 'Key 缺失',
          `书架 ${this.plugin.settings.shelfAccounts.length || this.plugin.settings.accounts.length} 个 · 已选 ${this.plugin.settings.accounts.length}`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      // 第二行：网页登录态（短命，列表/正文全靠它）—— 这里才是 -2012 的来源
      const webOk = this.plugin.settings.webLoginOk;
      txt.createDiv({
        cls: `wmc-login-web ${webOk === true ? 'is-ok' : webOk === false ? 'is-bad' : 'is-unknown'}`,
        text: `网页登录态：${this.plugin.webLoginSummary()}`,
      });
    }

    // 有登录态但还没拉过资料时，异步补一次（不阻塞界面）
    if (!prof && st !== 'none') {
      void this.plugin.refreshProfile().then((p) => {
        if (p) this.refreshUI();
      });
    }

    const loginBtns: { text: string; cta?: boolean; onClick: () => unknown }[] = [
      {
        text: st === 'full' ? '重新扫码' : '扫码登录',
        cta: true,
        onClick: () => this.plugin.startIframeLogin(),
      },
    ];
    if (st !== 'none') {
      loginBtns.push({
        text: '退出登录',
        onClick: async () => {
          // 彻底清态：cookie / 官方 Key / 头像 / 书架缓存 / 网页登录态，清完可干净重扫
          await this.plugin.logoutAccount();
          this.refreshUI();
        },
      });
    }
    loginBtns.push(
      {
        text: '同步书架',
        onClick: async () => {
          const n = await this.plugin.syncAccountsFromShelf();
          new Notice(n ? `已同步 ${n} 个公众号` : '同步失败：先完成扫码登录');
          this.refreshUI();
        },
      },
      {
        text: '测试列表',
        onClick: async () => {
          new Notice(await this.plugin.testConnection(), 8000);
        },
      },
    );
    this.frButtons(
      containerEl,
      '扫码登录',
      '点「重新扫码」，用微信扫弹窗里的二维码并确认。登录态会直接落进 Obsidian，不需要复制任何东西。',
      loginBtns,
    );

    // 高级：手动 Cookie（渐进展开，不占视觉）
    const adv = containerEl.createEl('details', { cls: 'wmc-adv' });
    adv.createEl('summary', { text: '高级：手动 cookie / 诊断' });
    this.frButtons(
      adv,
      '从 Chrome 导入登录态',
      'Chrome 需以 --remote-debugging-port=9222 启动（先完全退出 Chrome）且登录过 weread.qq.com，这样能拿到含 wr_gid 的完整 cookie。',
      [
        {
          text: '导入',
          onClick: async () => {
            const r = await this.plugin.importCookieFromChrome();
            new Notice(r, r.startsWith('OK') ? 12000 : 16000);
            this.refreshUI();
          },
        },
      ],
    );
    this.frButtons(
      adv,
      '用 Chrome 登录（Windows 推荐）',
      '插件会拉起本机 Chrome / Edge 打开微信读书，你在窗口里正常登录（扫码），成功后自动导入 cookie 并关闭窗口。',
      [{ text: '开始', onClick: () => void this.plugin.loginWithChrome() }],
    );
    this.frButtons(adv, '诊断登录态', '把 cookie 与 session 的探测结果写入插件目录「诊断.txt」', [
      { text: '运行诊断', onClick: () => this.plugin.diagnoseLogin() },
    ]);
    this.frArea(
      adv,
      'Cookie',
      '仅当扫码取不到登录态时使用；四项齐全才不会报 -2012',
      this.plugin.settings.cookie,
      async (v) => {
        this.plugin.settings.cookie = v.trim();
        await this.plugin.saveAll();
        // 保存即验证：直接把「格式完整但服务端过期」在当场点出来
        await this.plugin.verifyCookieLive(true);
      },
      {
        placeholder: 'wr_vid=…; wr_skey=…; wr_rt=…; wr_gid=…',
        rows: 3,
        button: {
          text: '换取官方 Key',
          onClick: async () => {
            const k = await this.plugin.refreshApiKey();
            new Notice(k ? '已获取官方 API Key' : '换取失败：登录态无效');
            if (k) this.refreshUI();
          },
        },
      },
    );

    /* 2. 公众号：搜索 + 勾选 */
    containerEl.createDiv({ cls: 'wmc-settings-h', text: '本地 Agent' });
    const agentPreset =
      AGENT_PRESETS.find((p) => p.id === this.plugin.settings.agent.preset) || AGENT_PRESETS[0];
    this.frSelect(
      containerEl,
      'Agent 类型',
      '插件会调用这个本地 CLI 干活（读笔记、写笔记、跑命令）。默认 Hermes，也可换成你已装的其他 Agent。',
      AGENT_PRESETS.map((p) => ({ id: p.id, label: p.label })),
      agentPreset.id,
      async (v) => {
        this.plugin.settings.agent.preset = v;
        await this.plugin.saveAll();
        this.refreshUI();
      },
      {
        text: '测试连接',
        onClick: async () => {
          const t = new Notice('正在测试 agent…', 0);
          try {
            const r = await this.plugin.runAgent('只回四个字：在线可用');
            t.hide();
            new Notice(
              r.code === 0
                ? `可用 · 返回：${r.out.trim().slice(0, 60)}`
                : `失败（退出码 ${r.code}）：${(r.err || '无错误输出').slice(0, 140)}`,
              10000,
            );
          } catch (e) {
            t.hide();
            new Notice(`失败：${e instanceof Error ? e.message : String(e)}`, 9000);
          }
        },
      },
    );
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `实际执行：${agentPreset.hint}`,
    });

    if (this.plugin.settings.agent.preset === 'custom') {
      this.frText(
        containerEl,
        '命令',
        platformName() === 'win32'
          ? '要执行的程序，例如 C:////Users////me////AppData////Roaming////npm////my-agent.cmd'
          : '要执行的程序，例如 /usr/local/bin/my-agent',
        this.plugin.settings.agent.cmd,
        async (v) => {
          this.plugin.settings.agent.cmd = v;
          await this.plugin.saveAll();
        },
      );
      this.frText(
        containerEl,
        '参数',
        '空格分隔，用 {prompt} 代表提问内容，例如 --json {prompt}',
        this.plugin.settings.agent.args.join(' '),
        async (v) => {
          this.plugin.settings.agent.args = v.split(/\s+/).filter(Boolean);
          await this.plugin.saveAll();
        },
      );
    }

    this.frToggle(
      containerEl,
      '文章内嵌入 Agent 侧栏',
      '打开文章时右侧并排显示 Agent（边读边处理）。关掉则只在详情页 Tab 里出现',
      this.plugin.settings.agentDocked,
      async (v) => {
        this.plugin.settings.agentDocked = v;
        await this.plugin.saveAll();
      },
    );

    this.frText(
      containerEl,
      '工作目录',
      'Agent 执行时的当前目录；留空 = 当前库根目录',
      this.plugin.settings.agent.cwd,
      async (v) => {
        this.plugin.settings.agent.cwd = v.trim();
        await this.plugin.saveAll();
      },
      { wide: true },
    );

    containerEl.createDiv({ cls: 'wmc-settings-h', text: '盯采公众号' });
    this.renderPicker(containerEl);

    const adv2 = containerEl.createEl('details', { cls: 'wmc-adv' });
    adv2.createEl('summary', { text: '手动添加（书架上没有的号）' });
    this.frArea(
      adv2,
      '名称 | MP_WXS_xxx',
      '一行一个，也接受阅读页 URL',
      this.accountsDraft,
      (v) => {
        this.accountsDraft = v;
      },
      {
        placeholder: '机器之心 | MP_WXS_3073282833',
        rows: 3,
        button: {
          text: '添加',
          onClick: async () => {
            const added = this.parseAccounts(this.accountsDraft);
            if (!added.length) {
              new Notice('没识别到 bookid（需要 MP_WXS_ 开头的 ID）');
              return;
            }
            for (const a of added) {
              if (!this.plugin.settings.accounts.some((x) => x.bookId === a.bookId)) {
                this.plugin.settings.accounts.push(a);
              }
            }
            await this.plugin.saveAll();
            this.accountsDraft = '';
            this.refreshUI();
          },
        },
      },
    );

    /* 3. 输出与节奏 */
    containerEl.createDiv({ cls: 'wmc-settings-h', text: '输出' });
    this.frText(
      containerEl,
      '笔记目录',
      '库内相对路径，图片落在 <目录>/assets/<标题>/',
      this.plugin.settings.outputDir,
      async (v) => {
        this.plugin.settings.outputDir = v.trim() || DEFAULTS.outputDir;
        await this.plugin.saveAll();
      },
      { wide: true },
    );

    containerEl.createDiv({ cls: 'wmc-settings-h', text: '盯采节奏' });
    this.frText(
      containerEl,
      '轮询间隔（分钟）',
      '下限 15 分钟；公众号发文是小时级，30 分钟即准实时',
      String(this.plugin.settings.intervalMin),
      async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          this.plugin.settings.intervalMin = Math.max(MIN_INTERVAL, Math.round(n));
          await this.plugin.saveAll();
        }
      },
      { numeric: true },
    );

    this.frText(
      containerEl,
      '每号检查条数 / 翻页数',
      '每页 20 条；翻页越多越耗请求',
      String(this.plugin.settings.pages),
      async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1) {
          this.plugin.settings.pages = Math.min(5, Math.round(n));
          await this.plugin.saveAll();
        }
      },
      { numeric: true },
    );

    this.frPair(
      containerEl,
      '单轮上限 / 每号上限',
      '控制单轮落盘量，避免一次性抓太多',
      {
        value: String(this.plugin.settings.maxPerRun),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.maxPerRun = Math.min(30, Math.round(n));
            await this.plugin.saveAll();
          }
        },
      },
      {
        value: String(this.plugin.settings.maxPerAccount),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.maxPerAccount = Math.min(10, Math.round(n));
            await this.plugin.saveAll();
          }
        },
      },
    );

    this.frToggle(
      containerEl,
      '防风控保护（建议开启）',
      '开启时每次加载都会强制收敛到安全档：每轮检查号数 ≤3、列表间隔 ≥6000ms、轮询间隔 ≥45 分钟、正文间隔 ≥4500ms。你在界面上填得更激进也会被拉回；确实要跑更快的参数，得先关掉这个开关',
      this.plugin.settings.rateSafeMode !== false,
      async (v) => {
        this.plugin.settings.rateSafeMode = v;
        await this.plugin.saveAll();
        this.display();
      },
    );

    this.frPair(
      containerEl,
      '每轮检查号数 / 列表间隔(ms)',
      '公众号多的时候别一次全拉：27 个号全量拉一轮 = 27 次列表请求，很容易触发 -2014。间隔建议 ≥2500ms',
      {
        value: String(this.plugin.settings.maxAccountsPerRun ?? 5),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.maxAccountsPerRun = Math.min(50, Math.round(n));
            await this.plugin.saveAll();
          }
        },
      },
      {
        value: String(this.plugin.settings.delayListMs ?? 2500),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 500) {
            this.plugin.settings.delayListMs = Math.min(30000, Math.round(n));
            await this.plugin.saveAll();
          }
        },
      },
    );

    this.frText(
      containerEl,
      '正文间隔(ms)',
      '抓每篇文章正文之间的等待。防风控保护开启时会自动抬到 ≥4500ms',
      String(this.plugin.settings.delayContentMs ?? 4500),
      async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 300) {
          this.plugin.settings.delayContentMs = Math.min(60000, Math.round(n));
          await this.plugin.saveAll();
        }
      },
      { numeric: true },
    );

    // 实时估算请求量：让「会不会被限流」变成看得见的数字
    {
      const perRun = Math.max(1, this.plugin.settings.maxAccountsPerRun ?? 5);
      const interval = Math.max(MIN_INTERVAL, this.plugin.settings.intervalMin || 30);
      const roundsPerDay = Math.floor((24 * 60) / interval);
      const mine = perRun * roundsPerDay;
      const naive = 27 * roundsPerDay;
      const coverHours = Math.ceil(27 / perRun) * (interval / 60);
      containerEl.createDiv({
        cls: 'wmc-qr-hint',
        text:
          `当前估算：每轮 ${perRun} 次列表请求 × 每天约 ${roundsPerDay} 轮 ≈ ${mine} 次/天` +
          `（27 个号全量拉则是 ${naive} 次/天）；覆盖一遍全部公众号约需 ${coverHours.toFixed(1)} 小时。` +
          `保守档参考：每轮 3、间隔 6000ms、45 分钟一轮 → 约 96 次/天。`,
      });
    }

    const coolUntil = this.plugin.state.listCooldownUntil ?? 0;
    if (coolUntil > Date.now()) {
      const row = new Setting(containerEl)
        .setName('列表接口限频冷却中（-2014）')
        .setDesc(
          `已暂停发请求到 ${new Date(coolUntil).toLocaleString()}（连续命中 ${this.plugin.state.listCooldownHits ?? 1} 次，退避自动加长）。确认已解除（比如浏览器里能正常打开公众号列表）再手动解除。`,
        );
      row.addButton((b) =>
        b
          .setButtonText('解除冷却')
          .setWarning()
          .onClick(async () => {
            this.plugin.state.listCooldownUntil = 0;
            this.plugin.state.listCooldownHits = 0;
            await this.plugin.saveAll();
            this.display();
          }),
      );
    }

    this.frToggle(
      containerEl,
      '图片本地化',
      '下载正文图片到库内 assets，避免外链失效',
      this.plugin.settings.downloadImages,
      async (v) => {
        this.plugin.settings.downloadImages = v;
        await this.plugin.saveAll();
      },
    );

    this.frToggle(
      containerEl,
      '启动时自动盯采',
      '默认关闭。关闭时插件不会有任何自动行为：不轮询、不抓取、不写笔记；只有你点「开始更新」/「立即抓取一轮」才会归档',
      this.plugin.settings.autoStart,
      async (v) => {
        this.plugin.settings.autoStart = v;
        await this.plugin.saveAll();
      },
    );

    /* 4. AI 模型 */
    containerEl.createDiv({ cls: 'wmc-settings-h', text: 'AI 模型（可选）' });
    const llm = this.plugin.settings.llm;

    this.frSelect(
      containerEl,
      '服务商',
      PROVIDERS[llm.provider]?.note ?? '任何 OpenAI 兼容端点',
      Object.entries(PROVIDERS).map(([id, prov]) => ({ id, label: prov.label })),
      llm.provider,
      async (v) => {
        llm.provider = v as ProviderId;
        const preset = PROVIDERS[v as ProviderId];
        if (preset?.baseUrl) llm.baseUrl = preset.baseUrl;
        if (preset?.model) llm.model = preset.model;
        await this.plugin.saveAll();
        this.refreshUI();
      },
    );

    this.frText(
      containerEl,
      'Base URL',
      'OpenAI 兼容地址，例如 https://api.deepseek.com/v1',
      llm.baseUrl,
      async (v) => {
        llm.baseUrl = v.trim();
        await this.plugin.saveAll();
      },
      { wide: true, placeholder: 'https://api.deepseek.com/v1' },
    );

    this.frText(
      containerEl,
      'API Key',
      '只存在本库插件数据里；本地 Ollama 可留空',
      llm.apiKey,
      async (v) => {
        llm.apiKey = v.trim();
        await this.plugin.saveAll();
      },
      { password: true, wide: true, placeholder: 'sk-…' },
    );

    this.frText(
      containerEl,
      '模型名',
      undefined,
      llm.model,
      async (v) => {
        llm.model = v.trim();
        await this.plugin.saveAll();
      },
      { wide: true },
    );

    this.frPair(
      containerEl,
      '温度 / 最大输出',
      undefined,
      {
        value: String(llm.temperature),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 2) {
            llm.temperature = n;
            await this.plugin.saveAll();
          }
        },
      },
      {
        value: String(llm.maxTokens),
        onChange: async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 64) {
            llm.maxTokens = Math.min(8000, Math.round(n));
            await this.plugin.saveAll();
          }
        },
      },
    );

    this.frText(
      containerEl,
      '每日调用上限',
      `今天已用 ${this.plugin.state.llmQuota?.count ?? 0} 次`,
      String(llm.dailyCallLimit),
      async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1) {
          llm.dailyCallLimit = Math.round(n);
          await this.plugin.saveAll();
        }
      },
      { numeric: true },
    );

    this.frToggle(
      containerEl,
      '入库自动摘要',
      '默认关。开启后每篇归档完成自动调一次模型（约 ¥0.01/篇）',
      llm.autoSummarize,
      async (v) => {
        llm.autoSummarize = v;
        await this.plugin.saveAll();
      },
    );

    this.frButtons(containerEl, '测试连接', undefined, [
      {
        text: '测一下',
        onClick: async () => {
          new Notice('测试中…', 3000);
          new Notice(await this.plugin.testLLMConnection(), 8000);
        },
      },
    ]);

    /* 5. 状态 */
    containerEl.createDiv({ cls: 'wmc-settings-h', text: '状态' });
    const last = this.plugin.state.lastRun;
    const statusBox = containerEl.createDiv('wmc-status');
    statusBox.createEl('p', {
      text: last
        ? `上次运行 ${new Date(last.at).toLocaleString()}｜发现 ${last.found}｜落盘 ${last.written}｜跳过 ${last.skipped}${
            last.error ? `｜${last.error}` : ''
          }`
        : '还没有运行记录',
    });
    statusBox.createEl('p', { text: `已归档：${Object.keys(this.plugin.state.processed).length} 篇` });

    this.frButtons(containerEl, '立即抓取一轮', undefined, [
      { text: '抓取', cta: true, onClick: () => this.plugin.runOnce(true) },
      {
        text: '清空已归档记录',
        danger: true,
        onClick: async () => {
          this.plugin.state.processed = {};
          await this.plugin.saveAll();
          new Notice('已清空（不会删除已有笔记，但会重复抓取）');
          this.refreshUI();
        },
      },
    ]);

    this.renderAbout(containerEl);
  }


  /* ==========================================================================
     设置行 · 手写 DOM 范式（替代 Obsidian 的 new Setting 表单行）
     原生 .setting-item 视觉太弱、开关不可自绘、双输入组排布僵硬。
     这里全部自建：标签左 / 控件右 / 说明在下；颜色走 --wmc-* token。
     ========================================================================== */

  /** 行骨架：返回右侧控件容器 */
  private fr(parent: HTMLElement, label: string, hint?: string, stack = false): HTMLElement {
    const row = parent.createDiv({ cls: stack ? 'wmc-fr is-stack' : 'wmc-fr' });
    const main = row.createDiv('wmc-fr-main');
    main.createDiv({ cls: 'wmc-fr-label', text: label });
    if (hint) main.createDiv({ cls: 'wmc-fr-hint', text: hint });
    return row.createDiv('wmc-fr-ctrl');
  }

  /** 按钮组 */
  private frButtons(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    buttons: { text: string; cta?: boolean; danger?: boolean; onClick: () => unknown }[],
  ): void {
    const ctrl = this.fr(parent, label, hint);
    for (const b of buttons) {
      const el = ctrl.createEl('button', {
        cls: `wmc-fr-btn${b.cta ? ' is-cta' : ''}${b.danger ? ' is-danger' : ''}`,
        text: b.text,
      });
      el.addEventListener('click', () => void b.onClick());
    }
  }

  /** 单行输入 */
  private frText(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    value: string,
    onChange: (v: string) => unknown,
    opts: { password?: boolean; numeric?: boolean; wide?: boolean; placeholder?: string } = {},
  ): void {
    const ctrl = this.fr(parent, label, hint);
    const inp = ctrl.createEl('input', {
      cls: `wmc-fr-input${opts.numeric ? ' is-num' : ''}${opts.wide ? ' is-wide' : ''}`,
    });
    inp.type = opts.password ? 'password' : 'text';
    if (opts.numeric) inp.inputMode = 'numeric';
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    inp.value = value;
    // 数字框用 change：避免输入中间值（"1" → "12"）被当成最终值存盘
    inp.addEventListener(opts.numeric ? 'change' : 'input', () => void onChange(inp.value));
  }

  /** 双数字输入（单轮/每号、温度/最大输出） */
  private frPair(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    a: { value: string; onChange: (v: string) => unknown },
    b: { value: string; onChange: (v: string) => unknown },
    sep = '/',
  ): void {
    const ctrl = this.fr(parent, label, hint);
    const wrap = ctrl.createDiv('wmc-fr-pair');
    const mk = (v: string, cb: (x: string) => unknown) => {
      const inp = wrap.createEl('input', { cls: 'wmc-fr-input is-num' });
      inp.type = 'text';
      inp.inputMode = 'numeric';
      inp.value = v;
      inp.addEventListener('change', () => void cb(inp.value));
    };
    mk(a.value, a.onChange);
    wrap.createDiv({ cls: 'wmc-fr-sep', text: sep });
    mk(b.value, b.onChange);
  }

  /** 开关（自绘，不用 Obsidian checkbox） */
  private frToggle(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    value: boolean,
    onChange: (v: boolean) => unknown,
  ): void {
    const ctrl = this.fr(parent, label, hint);
    const sw = ctrl.createDiv({ cls: `wmc-fr-switch${value ? ' is-on' : ''}` });
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(value));
    // 用 visually-hidden 文本给出可读名，避免 Obsidian 把 aria-label 映射成 hover 气泡
    sw.createSpan({ cls: 'wmc-sr', text: label });
    sw.tabIndex = 0;
    const flip = () => {
      const next = !sw.hasClass('is-on');
      sw.toggleClass('is-on', next);
      sw.setAttribute('aria-checked', String(next));
      void onChange(next);
    };
    sw.addEventListener('click', flip);
    sw.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        flip();
      }
    });
  }

  /** 下拉（可带一个附加按钮） */
  private frSelect(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    options: { id: string; label: string }[],
    value: string,
    onChange: (v: string) => unknown,
    extra?: { text: string; onClick: () => unknown },
  ): void {
    const ctrl = this.fr(parent, label, hint);
    const sel = ctrl.createEl('select', { cls: 'wmc-fr-select' });
    for (const o of options) sel.createEl('option', { value: o.id, text: o.label });
    sel.value = value;
    sel.addEventListener('change', () => void onChange(sel.value));
    if (extra) {
      const btn = ctrl.createEl('button', { cls: 'wmc-fr-btn', text: extra.text });
      btn.addEventListener('click', () => void extra.onClick());
    }
  }

  /** 多行文本（整行竖排，可带底部按钮） */
  private frArea(
    parent: HTMLElement,
    label: string,
    hint: string | undefined,
    value: string,
    onChange: (v: string) => unknown,
    opts: {
      placeholder?: string;
      rows?: number;
      button?: { text: string; onClick: () => unknown };
    } = {},
  ): void {
    const ctrl = this.fr(parent, label, hint, true);
    const ta = ctrl.createEl('textarea', { cls: 'wmc-fr-area' });
    ta.value = value;
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    if (opts.rows) ta.rows = opts.rows;
    ta.addEventListener('input', () => void onChange(ta.value));
    const btnCfg = opts.button;
    if (btnCfg) {
      const bar = ctrl.createDiv('wmc-fr-ctrl');
      const btn = bar.createEl('button', { cls: 'wmc-fr-btn', text: btnCfg.text });
      btn.addEventListener('click', () => void btnCfg.onClick());
    }
  }

  /**
   * 关于：作者信息 + 公众号 + 打赏。
   * 全部手写 DOM（不用 Setting 行）；配色走 Obsidian 原生变量，自动适配明暗主题；
   * 二维码用 webp base64 内嵌（插件分发不带额外文件，外链会 404）。
   */
  private renderAbout(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv('wmc-about');
    wrap.createDiv({ cls: 'wmc-settings-h', text: '关于' });

    const card = wrap.createDiv('wmc-about-card');
    const av = card.createEl('img', { cls: 'wmc-about-avatar' });
    av.src = ASSET_AVATAR;
    av.alt = '紫苏子ACG';

    const info = card.createDiv('wmc-about-info');
    info.createDiv({ cls: 'wmc-about-name', text: 'Zisuzi-Weread-MP' });
    info.createDiv({ cls: 'wmc-about-ver', text: `v${this.plugin.manifest.version} · GPL-3.0-only` });
    info.createDiv({ cls: 'wmc-about-by', text: '紫苏子ACG · 独立动画导演 · 尊胜精进院' });

    const links = info.createDiv('wmc-about-links');
    const addLink = (text: string, href: string) => {
      const a = links.createEl('a', { cls: 'wmc-about-link', text });
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    };
    addLink('GitHub', 'https://github.com/pixelxzen');
    addLink('小红书', 'https://www.xiaohongshu.com/user/profile/5b80023bd72b6300011273e6');
    addLink('问题反馈', 'https://github.com/pixelxzen/Zisuzi-Weread-MP/issues');
    addLink('更新日志', 'https://github.com/pixelxzen/Zisuzi-Weread-MP/releases');

    const grid = wrap.createDiv('wmc-about-support');
    const tile = (src: string, icon: string, title: string, sub: string) => {
      const t = grid.createDiv('wmc-about-tile');
      const head = t.createDiv('wmc-about-tile-head');
      setIcon(head.createSpan('wmc-about-tile-ico'), icon);
      head.createSpan({ text: title });
      const img = t.createEl('img', { cls: 'wmc-about-qr' });
      img.src = src;
      img.alt = title;
      img.loading = 'lazy';
      t.createDiv({ cls: 'wmc-about-tile-sub', text: sub });
    };
    tile(ASSET_MP_QR, 'qr-code', '关注公众号', '扫码看更多作品与更新');
    tile(ASSET_TIP_QR, 'coffee', '请我喝杯咖啡', '微信扫码支持持续维护');
  }

  /** 书架公众号选号器：搜索 + 勾选（分片渲染，支持上千个号） */
  private renderPicker(parent: HTMLElement): void {
    const plug = this.plugin;
    const shelf = plug.settings.shelfAccounts.length
      ? plug.settings.shelfAccounts
      : plug.settings.accounts;
    const picked = new Set(plug.settings.accounts.map((a) => a.bookId));

    const wrap = parent.createDiv('wmc-picker');
    const head = wrap.createDiv('wmc-picker-head');
    head.createSpan({ cls: 'wmc-picker-count', text: `已选 ${picked.size} / 书架 ${shelf.length}` });
    if (!plug.settings.shelfAccounts.length) {
      head.createSpan({ cls: 'wmc-picker-hint', text: '（点上方「同步书架」拉取全部订阅）' });
    }

    const searchWrap = wrap.createDiv('wmc-picker-search');
    const input = searchWrap.createEl('input', { type: 'search', placeholder: '搜索公众号名称…' });
    input.addClass('wmc-picker-input');

    const listEl = wrap.createDiv('wmc-picker-list');
    let filter = '';

    const syncCount = () => {
      const el = head.querySelector('.wmc-picker-count');
      if (el) el.setText(`已选 ${plug.settings.accounts.length} / 书架 ${shelf.length}`);
    };

    const toggle = async (acc: AccountRef, on: boolean) => {
      if (on) {
        if (!plug.settings.accounts.some((x) => x.bookId === acc.bookId)) plug.settings.accounts.push(acc);
        picked.add(acc.bookId);
      } else {
        plug.settings.accounts = plug.settings.accounts.filter((x) => x.bookId !== acc.bookId);
        picked.delete(acc.bookId);
      }
      await plug.saveAll();
      syncCount();
    };

    const draw = () => {
      listEl.empty();
      const items = shelf.filter((a) => !filter || a.name.toLowerCase().includes(filter) || a.bookId.includes(filter));
      if (!items.length) {
        listEl.createDiv({ cls: 'wmc-empty', text: '没有匹配的公众号' });
        return;
      }
      let i = 0;
      const chunk = 100;
      const step = () => {
        const frag = createFragment();
        for (const a of items.slice(i, i + chunk)) {
          const label = createEl('label', { cls: 'wmc-pick-row' });
          const cb = label.createEl('input', { cls: 'wmc-pick-cb', attr: { type: 'checkbox' } });
          cb.checked = picked.has(a.bookId);
          cb.addEventListener('change', () => void toggle(a, cb.checked));
          const nm = label.createSpan({ cls: 'wmc-pick-name' });
          nm.textContent = a.name;
          const id = label.createSpan({ cls: 'wmc-pick-id' });
          id.textContent = a.bookId.replace('MP_WXS_', '#');
          frag.appendChild(label);
        }
        i += chunk;
        listEl.appendChild(frag);
        if (i < items.length) window.setTimeout(step, 0);
      };
      step();
    };

    input.addEventListener('input', () => {
      filter = input.value.trim().toLowerCase();
      draw();
    });
    draw();

    this.frButtons(wrap, '批量操作', '只作用于当前搜索结果', [
      {
        text: '全选结果',
        onClick: async () => {
          const items = shelf.filter(
            (a) => !filter || a.name.toLowerCase().includes(filter) || a.bookId.includes(filter),
          );
          for (const a of items) {
            if (!picked.has(a.bookId)) {
              plug.settings.accounts.push(a);
              picked.add(a.bookId);
            }
          }
          await plug.saveAll();
          syncCount();
          draw();
        },
      },
      {
        text: '清空',
        danger: true,
        onClick: async () => {
          plug.settings.accounts = [];
          picked.clear();
          await plug.saveAll();
          syncCount();
          draw();
        },
      },
    ]);
  }

  private parseAccounts(raw: string): AccountRef[] {
    const out: AccountRef[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const m = /MP_WXS_\d+/i.exec(s);
      if (!m) continue;
      // 统一大写：前缀是微信读书的类型标记，大小写敏感，手打小写会匹配不上接口
      const bookId = m[0].toUpperCase();
      let name = s.replace(m[0], '').replace(/[|｜,，\t]+/g, ' ').trim();
      if (!name) name = bookId;
      out.push({ name, bookId });
    }
    return out;
  }
}
