import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  type RequestUrlParam,
} from 'obsidian';
import {
  WereadClient,
  checkCookie,
  normalizeCookie,
  fetchProfile,
  probeAccess,
  type ArticleItem,
  type HttpFn,
  RiskError,
} from './core/weread';
import { htmlToMarkdown, replaceImagePlaceholders, replaceMediaPlaceholders, safeFileName } from './core/html2md';
import { WmcView, VIEW_TYPE_WMC } from './host/view-linear';
import { BackfillModal } from './host/backfill-modal';
import { WereadAgentApi, fetchApiKey } from './core/weread-api';
import {
  LLM_DEFAULTS,
  PROVIDERS,
  chat as llmChat,
  summarize as llmSummarize,
  testConnection as testLLM,
  estimateTokens,
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
  outputDir: string;
  listWidth: number;
  llm: LLMSettings;
  pages: number;
  intervalMin: number;
  maxPerRun: number;
  maxPerAccount: number;
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
}

interface WMState {
  processed: Record<string, ProcessedEntry>;
  discovered?: Record<string, DiscoveredEntry>;
  read?: Record<string, number>;
  summaries?: Record<string, string>;
  accountOffsets?: Record<string, number>;
  llmQuota?: { day: string; count: number };
  lastRun?: { at: number; found: number; written: number; skipped: number; error?: string };
  watchSince?: number;
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
  intervalMin: 30,
  maxPerRun: 6,
  maxPerAccount: 2,
  delayListMs: 1200,
  delayContentMs: 2500,
  downloadImages: true,
  autoStart: false,
};

const MIN_INTERVAL = 15; // 风控下限：低于 15 分钟不进风控红线
const ID = 'zisuzi-weread-mp';

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

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
  private http: HttpFn = async (url: string, headers: Record<string, string>) => {
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
      name: '切换界面主题（Linear ⇄ 紫苏子品牌）',
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
    this.addCommand({
      id: 'backfill',
      name: '归档某个号的全部历史（分批·防风控）',
      callback: () => new BackfillModal(this.app, this).open(),
    });

    this.addSettingTab(new WMSettingTab(this.app, this));

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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron: any = (window as any).require?.('electron');
      const remote = electron?.remote;
      const session = remote?.session?.defaultSession;
      if (!session?.cookies?.get) return null;
      const list: Array<{ name: string; value: string; domain: string }> = await session.cookies.get({
        domain: '.weread.qq.com',
      });
      if (!list?.length) return null;
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return null;
    }
  }

  /** 打开登录窗口（Electron 新窗口，与 Obsidian 共享 session），并轮询等 cookie 成熟后自动写入 */
  openLoginWindow() {
    const w = window.open('https://weread.qq.com/', '_blank');
    if (!w) {
      new Notice('无法打开窗口：请改用浏览器登录后粘贴 Cookie');
      return;
    }
    new Notice('扫码登录中…完成后会自动写入（最长等 90 秒）', 6000);
    void this.waitForMatureCookie(90000).then((ok) => {
      if (ok) {
        new Notice('登录成功，完整 Cookie 已写入');
        void this.refreshApiKey();
        void this.refreshProfile();
      } else {
        new Notice('90 秒内没读到完整登录态。若已扫码，请点「设置 → 读取登录态」重试', 10000);
      }
    });
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
    return true;
  }

  /* ------------------------------ 补图 / 再采集 ------------------------------ */

  /**
   * 修复一篇笔记的图片：从 source 里的 reviewId 重新拉正文，下载全部图片，
   * 再把笔记里的图片链接重写为带尖括号的相对路径（路径含空格时必需）。
   */
  async repairNote(f: TFile): Promise<{ ok: number; fail: number; total: number }> {
    const md = await this.app.vault.read(f);
    const m = /^source:\s*"?weread:\/\/([^"\n]+)"?/m.exec(md);
    if (!m) throw new Error('这篇笔记里没有 weread 来源标记，无法定位原文');
    const reviewId = m[1].trim();
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!checkCookie(cookie).ok) throw new Error('登录态无效，请先去设置里扫码登录');

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
    const walk = (node: any) => {
      if (node instanceof TFile) {
        if (node.extension === 'md') files.push(node);
        return;
      }
      for (const child of node?.children || []) walk(child);
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = (window as any).require?.('child_process');
    if (!cp?.spawn) throw new Error('当前环境不支持执行本地命令（仅桌面端可用）');

    const cfg = this.settings.agent || { preset: 'hermes', cmd: '', args: [], cwd: '' };
    const preset = AGENT_PRESETS.find((p) => p.id === cfg.preset) || AGENT_PRESETS[0];
    const cmd = (cfg.preset === 'custom' && cfg.cmd ? cfg.cmd : preset.cmd).trim();
    const rawArgs = cfg.preset === 'custom' && cfg.args?.length ? cfg.args : preset.args;
    if (!cmd) throw new Error('还没配置 Agent 命令');
    const args = rawArgs.map((a) => a.replace('{prompt}', prompt));

    // Obsidian 是 GUI 进程，PATH 往往只有 /usr/bin:/bin —— 必须手工补全
    const home = (window as any).require?.('os')?.homedir?.() || '';
    const baseEnv = (window as any).process?.env || {};
    const env = {
      ...baseEnv,
      PATH: ['/opt/homebrew/bin', '/usr/local/bin', home ? `${home}/.local/bin` : '', home ? `${home}/.kimi-code/bin` : '', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
        .filter(Boolean)
        .join(':'),
    };
    const cwd = cfg.cwd || (this.app.vault.adapter as any).getBasePath?.() || undefined;

    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let child: any;
      try {
        child = cp.spawn(cmd, args, { cwd, env });
      } catch (e) {
        resolve({ code: -1, out: '', err: String(e), cmd });
        return;
      }
      child.stdout?.on('data', (d: any) => {
        const s = d.toString();
        out += s;
        onChunk?.(s);
      });
      child.stderr?.on('data', (d: any) => {
        err += d.toString();
      });
      child.on('error', (e: any) => resolve({ code: -1, out, err: `${err}\n${String(e)}`.trim(), cmd }));
      child.on('close', (code: number) => resolve({ code: code ?? -1, out, err, cmd }));
    });
  }

  /** 批量下载选中的文章（只下选的，不碰其他） */
  async archiveMany(rids: string[]): Promise<{ ok: number; fail: number }> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!checkCookie(cookie).ok) throw new Error('登录态无效，请先扫码登录');
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
    if (!checkCookie(cookie).ok) return 0;
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
          };
          added++;
        }
      }
      this.state.accountOffsets[acc.name] = offset + items.length;
      if (added || reset) await this.saveAll();
      this.notifyViews();
      if (reset && added) new Notice(`「${name}」首批 ${items.length} 篇已就绪，往下滚继续加载`, 5000);
      return items.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof RiskError) {
        new Notice(`登录过期了（-2012）：去设置 → 切换账号重新扫码，就能继续加载`, 10000);
      } else {
        new Notice(`加载「${name}」失败：${msg}`, 7000);
      }
      return 0;
    }
  }

  /** 滚到底时续拉下一页（20 条一页，与网页版一致） */
  async loadMoreForAccount(name: string): Promise<{ added: number; hasMore: boolean }> {
    const before = Object.keys(this.state.discovered || {}).length;
    const got = await this.fetchAccountList(name, false);
    const after = Object.keys(this.state.discovered || {}).length;
    return { added: after - before, hasMore: got >= 20 };
  }

  /** 登出：清本地登录态 + 清 Electron session 里 weread 域 cookie（不清的话重扫码还是旧账号） */
  async logout(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron: any = (window as any).require?.('electron');
      const session = electron?.remote?.session?.defaultSession;
      if (session?.clearStorageData) {
        await session.clearStorageData({ origin: 'https://weread.qq.com', storages: ['cookies'] });
      }
    } catch {
      /* 非 Electron 环境跳过 */
    }
    this.settings.cookie = '';
    this.settings.wereadApiKey = '';
    this.settings.loginProfile = undefined;
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
    this.emitWatch();
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
    if (!checkCookie(ck).ok) return null;
    const key = await fetchApiKey(this.llmHttp, ck);
    if (key) {
      this.settings.wereadApiKey = key;
      await this.saveAll();
    }
    return key;
  }

  /** 拉登录用户资料（昵称 / 头像 / VID / 简介） */
  async refreshProfile(): Promise<LoginProfile | null> {
    const ck = normalizeCookie(this.settings.cookie || '');
    if (!checkCookie(ck).ok) return null;
    const p = await fetchProfile(this.http, ck);
    if (p) {
      // 头像落地存插件目录，避免外链 CDN 被拦导致空白
      if (p.avatar) {
        try {
          const r = await requestUrl({
            url: p.avatar,
            method: 'GET',
            throw: false,
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
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

  /** 扫码登录：开窗口 → 轮询登录态 → 存登录态 + 换官方 Key + 同步书架 */
  async startQrLogin(): Promise<void> {
    const w = window.open('https://weread.qq.com/', '_blank');
    if (!w) {
      new Notice('无法打开登录窗口；请允许 Obsidian 打开新窗口');
      return;
    }
    new Notice('已打开登录窗口：微信扫码后自动完成，不需要复制任何东西', 10000);
    this.loginPolling = true;
    const t0 = Date.now();
    while (this.loginPolling && Date.now() - t0 < 6 * 60 * 1000) {
      await sleep(3000);
      const ck = await this.tryReadSessionCookie();
      if (!ck) continue;
      if (!checkCookie(ck).ok) continue;
      this.settings.cookie = normalizeCookie(ck);
      const key = await fetchApiKey(this.llmHttp, this.settings.cookie);
      if (key) this.settings.wereadApiKey = key;
      await this.saveAll();
      this.loginPolling = false;
      try {
        w.close();
      } catch {
        /* 用户已手动关闭 */
      }
      const n = await this.syncAccountsFromShelf();
      new Notice(`登录成功${key ? '，已获取官方 Key' : ''}${n ? `；书架 ${n} 个公众号` : ''}`, 10000);
      return;
    }
    this.loginPolling = false;
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
      if (manual) new Notice('还没登录：设置里粘贴 Cookie 或点击「打开登录窗口」');
      return;
    }
    const chk = checkCookie(cookie);
    if (!chk.ok) {
      if (manual) new Notice(`Cookie 不完整，缺：${chk.missing.join(', ')}（缺 wr_gid 会报 -2012）`, 8000);
    }
    const accounts = this.settings.accounts.filter((a) => a.bookId?.startsWith('MP_WXS_'));
    if (!accounts.length) {
      if (manual) new Notice('还没有公众号：设置里添加 bookId（MP_WXS_xxx）');
      return;
    }

    this.running = true;
    this.watch.busy = true;
    this.watch.phase = 'list';
    this.watch.accountIndex = 0;
    this.watch.accountTotal = accounts.length;
    this.watch.found = 0;
    this.watch.written = 0;
    this.watch.skipped = 0;
    this.watch.lastError = undefined;
    this.pushLog(`开始更新 · 检查 ${accounts.length} 个公众号`);
    this.emitWatch();
    const client = new WereadClient(this.http, cookie);
    let found = 0;
    let written = 0;
    let skipped = 0;
    let riskHit = false;

    try {
      // ① 收集新条目（按号轮转，保证公平）
      const queueByAccount: Array<{ acc: AccountRef; items: ArticleItem[] }> = [];
      for (const acc of accounts) {
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
      await this.saveAll();
      new Notice(`抓取中断：${msg}`);
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

  private async fetchOne(client: WereadClient, acc: AccountRef, item: ArticleItem): Promise<boolean> {
    const html = await client.getContentHtml(item.reviewId);
    const { markdown, images, media } = htmlToMarkdown(html);
    // 纯图片笔记（小绿书）/ 纯视频推送没有正文文本但有占位符 → 也要归档
    if (!markdown.trim() && !images.length && !media.length) return false;

    const base = safeFileName(item.title || '(无标题)');
    const dir = normalizePath(`${this.settings.outputDir}/${safeFileName(acc.name)}`);
    const assetDir = normalizePath(`${this.settings.outputDir}/assets/${base}`);
    await this.ensureFolder(dir);

    // 图片本地化
    const localPaths: string[] = [];
    if (this.settings.downloadImages && images.length) {
      await this.ensureFolder(assetDir);
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const buf = await client.fetchImage(img.src);
          const ext = guessExt(buf);
          const rel = normalizePath(`${assetDir}/img-${i + 1}.${ext}`);
          await this.app.vault.adapter.writeBinary(rel, buf);
          localPaths[i] = normalizePath(`../assets/${base}/img-${i + 1}.${ext}`);
        } catch {
          localPaths[i] = '';
        }
        await sleep(Math.round(this.settings.delayContentMs / 2));
      }
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
          await sleep(this.settings.delayContentMs);
        }
        if (!saved) mediaRefs.push({ ...m, url });
      }
    }

    let bodyMd = replaceImagePlaceholders(markdown, localPaths);
    if (media.length) bodyMd = replaceMediaPlaceholders(bodyMd, mediaRefs);
    const path = normalizePath(`${dir}/${base}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return false; // 幂等

    const published = fmtDate(item.time);
    const fmTags = ['剪藏', '微信读书公众号'];
    const note = [
      '---',
      `title: "${(item.title || '').replace(/"/g, '\\"')}"`,
      `date: ${ymdNow()}`,
      `source: "weread://${item.reviewId}"`,
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
    return true;
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

  /** 单号全量历史归档：分批翻页 + 风控节流 + 可中断 */
  async runBackfill(
    acc: AccountRef,
    opts: { maxItems: number; fromDate: string; speed: 'safe' | 'slow' },
    onProgress: (p: { phase: 'list' | 'fetch'; done: number; total: number; written: number; title?: string }) => void,
    signal: { stop: boolean },
  ): Promise<{ written: number; skipped: number; stopped: boolean; error?: string }> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!checkCookie(cookie).ok) return { written: 0, skipped: 0, stopped: true, error: '登录态无效，请重新扫码' };
    const client = new WereadClient(this.http, cookie);
    const T =
      opts.speed === 'slow'
        ? { list: 3000, content: 6000, every: 10, rest: 120000 }
        : { list: 1200, content: 2500, every: 15, rest: 60000 };
    const fromTs = opts.fromDate ? Math.floor(new Date(`${opts.fromDate}T00:00:00`).getTime() / 1000) : 0;

    // ① 翻列表
    const seen = new Set<string>();
    const list: ArticleItem[] = [];
    const maxPages = opts.maxItems > 0 ? Math.ceil(opts.maxItems / 20) + 3 : 300;
    for (let p = 0; p < maxPages; p++) {
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
      onProgress({ phase: 'list', done: p + 1, total: maxPages, written: 0, title: `已翻 ${p + 1} 页 · 累计 ${list.length} 篇` });
      if (added === 0) break;
      await sleep(T.list);
    }

    // ② 逐篇抓正文
    const todo = list
      .filter((a) => !this.state.processed[a.reviewId])
      .slice(0, opts.maxItems > 0 ? opts.maxItems : list.length);
    let written = 0;
    let skipped = 0;
    let n = 0;
    for (const it of todo) {
      if (signal.stop) break;
      n++;
      try {
        const ok = await this.fetchOne(client, acc, it);
        if (ok) written++;
        else skipped++;
      } catch (e) {
        if (e instanceof RiskError) {
          await this.saveAll();
          return { written, skipped, stopped: true, error: `命中风控 ${e.message}：已停止，不要立刻重试` };
        }
        skipped++;
      }
      onProgress({ phase: 'fetch', done: n, total: todo.length, written, title: it.title });
      if (n % T.every === 0) await sleep(T.rest);
      else await sleep(T.content);
    }
    await this.saveAll();
    return { written, skipped, stopped: signal.stop };
  }

  /** 用当前 cookie 探测书架号数（设置页「测试连接」用） */
  async testConnection(): Promise<string> {
    const cookie = normalizeCookie(this.settings.cookie || '');
    const chk = checkCookie(cookie);
    if (!chk.ok) return `Cookie 不完整，缺 ${chk.missing.join(', ')}`;
    const accounts = this.settings.accounts.filter((a) => a.bookId?.startsWith('MP_WXS_'));
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
      workspace.revealLeaf(inMain);
      return;
    }
    leaves.forEach((l) => l.detach());
    // 主标签页打开（对齐 qiaomu-home 的观感），不用右侧插件栏
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_WMC, active: true });
    workspace.revealLeaf(leaf);
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
    if (!f) return '';
    const md = await this.app.vault.cachedRead(f as any);
    const i = md.indexOf('## 正文');
    return i >= 0 ? md.slice(i + 5) : md;
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
      mpName: acc.name,
    };
    const cookie = normalizeCookie(this.settings.cookie || '');
    if (!cookie) {
      new Notice('还没登录：设置里填 Cookie');
      return false;
    }
    const client = new WereadClient(this.http, cookie);
    try {
      const ok = await this.fetchOne(client, acc, item);
      if (ok) await this.saveAll();
      return ok;
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
    if (!f) return false;
    const md = await this.app.vault.cachedRead(f as any);
    const marker = '## AI 摘要';
    const next = md.includes(marker)
      ? md.slice(0, md.indexOf(marker)).replace(/\s+$/, '') + block
      : md.replace(/\s+$/, '') + block;
    await this.app.vault.process(f as any, () => next);
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('wmc-settings');

    /* 1. 登录 */
    containerEl.createEl('h3', { text: '登录' });
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
    txt.createDiv({
      cls: 'wmc-login-sub',
      text:
        st === 'none'
          ? '扫码即可，不需要复制任何 Cookie'
          : [
              prof?.vid ? `VID ${prof.vid}` : '',
              st === 'full' ? '官方 Key 有效' : '登录态不完整',
              `书架 ${this.plugin.settings.shelfAccounts.length || this.plugin.settings.accounts.length} 个 · 已选 ${this.plugin.settings.accounts.length}`,
              prof?.desc || '',
            ]
              .filter(Boolean)
              .join(' · '),
    });

    // 有登录态但还没拉过资料时，异步补一次（不阻塞界面）
    if (!prof && st !== 'none') {
      void this.plugin.refreshProfile().then((p) => {
        if (p) this.display();
      });
    }

    const loginSetting = new Setting(containerEl)
      .setName('扫码登录')
      .setDesc('打开微信读书窗口扫码；完成后自动保存登录态、换出官方 API Key、同步书架公众号')
      .addButton((b) =>
        b
          .setButtonText(st === 'full' ? '重新扫码' : '扫码登录')
          .setCta()
          .onClick(() => void this.plugin.startQrLogin()),
      );
    if (st !== 'none') {
      loginSetting.addButton((b) =>
        b.setButtonText('切换账号').onClick(async () => {
          await this.plugin.logout();
          this.display();
          new Notice('已退出。正在打开登录窗口，扫码登录新账号…', 6000);
          this.plugin.startQrLogin();
        }),
      );
    }
    loginSetting
      .addButton((b) =>
        b.setButtonText('同步书架').onClick(async () => {
          const n = await this.plugin.syncAccountsFromShelf();
          new Notice(n ? `已同步 ${n} 个公众号` : '同步失败：先完成扫码登录');
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText('测试抓取').onClick(async () => {
          new Notice(await this.plugin.testConnection(), 8000);
        }),
      );

    // 高级：手动 Cookie（渐进展开，不占视觉）
    const adv = containerEl.createEl('details', { cls: 'wmc-adv' });
    adv.createEl('summary', { text: '高级：手动 Cookie（一般不需要）' });
    new Setting(adv)
      .setName('Cookie')
      .setDesc('仅当扫码取不到登录态时使用；四项齐全才不会报 -2012')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.cookie)
          .setPlaceholder('wr_vid=…; wr_skey=…; wr_rt=…; wr_gid=…')
          .onChange(async (v) => {
            this.plugin.settings.cookie = v.trim();
            await this.plugin.saveAll();
          });
        t.inputEl.rows = 3;
        t.inputEl.addClass('wmc-cookie');
      })
      .addButton((b) =>
        b.setButtonText('换取官方 Key').onClick(async () => {
          const k = await this.plugin.refreshApiKey();
          new Notice(k ? '已获取官方 API Key' : '换取失败：登录态无效');
          if (k) this.display();
        }),
      );

    /* 2. 公众号：搜索 + 勾选 */
    containerEl.createEl('h3', { text: '本地 Agent' });
    const agentPreset =
      AGENT_PRESETS.find((p) => p.id === this.plugin.settings.agent.preset) || AGENT_PRESETS[0];
    new Setting(containerEl)
      .setName('Agent 类型')
      .setDesc('插件会调用这个本地 CLI 干活（读笔记、写笔记、跑命令）。默认 Hermes，也可换成你已装的其他 Agent。')
      .addDropdown((dd) => {
        for (const p of AGENT_PRESETS) dd.addOption(p.id, p.label);
        dd.setValue(agentPreset.id);
        dd.onChange(async (v) => {
          this.plugin.settings.agent.preset = v;
          await this.plugin.saveAll();
          this.display();
        });
      })
      .addButton((b) =>
        b.setButtonText('测试连接').onClick(async () => {
          const t = new Notice('正在测试 Agent…', 0);
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
        }),
      );
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `实际执行：${agentPreset.hint}`,
    });

    if (this.plugin.settings.agent.preset === 'custom') {
      new Setting(containerEl)
        .setName('命令')
        .setDesc('要执行的程序，例如 /usr/local/bin/my-agent')
        .addText((t) =>
          t.setValue(this.plugin.settings.agent.cmd).onChange(async (v) => {
            this.plugin.settings.agent.cmd = v;
            await this.plugin.saveAll();
          }),
        );
      new Setting(containerEl)
        .setName('参数')
        .setDesc('空格分隔，用 {prompt} 代表提问内容，例如 --json {prompt}')
        .addText((t) =>
          t.setValue(this.plugin.settings.agent.args.join(' ')).onChange(async (v) => {
            this.plugin.settings.agent.args = v.split(/\s+/).filter(Boolean);
            await this.plugin.saveAll();
          }),
        );
    }

    new Setting(containerEl)
      .setName('文章内嵌入 Agent 侧栏')
      .setDesc('打开文章时右侧并排显示 Agent（边读边处理）。关掉则只在详情页 Tab 里出现')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.agentDocked).onChange(async (v) => {
          this.plugin.settings.agentDocked = v;
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl)
      .setName('工作目录')
      .setDesc('Agent 执行时的当前目录；留空 = 当前库根目录')
      .addText((t) =>
        t.setValue(this.plugin.settings.agent.cwd).onChange(async (v) => {
          this.plugin.settings.agent.cwd = v.trim();
          await this.plugin.saveAll();
        }),
      );

    containerEl.createEl('h3', { text: '盯采公众号' });
    this.renderPicker(containerEl);

    const adv2 = containerEl.createEl('details', { cls: 'wmc-adv' });
    adv2.createEl('summary', { text: '手动添加（书架上没有的号）' });
    new Setting(adv2)
      .setName('名称 | MP_WXS_xxx')
      .setDesc('一行一个，也接受阅读页 URL')
      .addTextArea((t) => {
        t.setPlaceholder('机器之心 | MP_WXS_3073282833');
        t.inputEl.rows = 3;
        t.inputEl.addClass('wmc-accounts-input');
        t.onChange((v) => (this.accountsDraft = v));
      })
      .addButton((b) =>
        b.setButtonText('添加').onClick(async () => {
          const added = this.parseAccounts(this.accountsDraft);
          if (!added) {
            new Notice('没识别到 bookId（需要 MP_WXS_ 开头）');
            return;
          }
          for (const a of added) {
            if (!this.plugin.settings.accounts.some((x) => x.bookId === a.bookId)) {
              this.plugin.settings.accounts.push(a);
            }
          }
          await this.plugin.saveAll();
          this.accountsDraft = '';
          this.display();
        }),
      );

    /* 3. 输出与节奏 */
    containerEl.createEl('h3', { text: '输出' });
    new Setting(containerEl)
      .setName('笔记目录')
      .setDesc('库内相对路径，图片落在 <目录>/assets/<标题>/')
      .addText((t) =>
        t.setValue(this.plugin.settings.outputDir).onChange(async (v) => {
          this.plugin.settings.outputDir = v.trim() || DEFAULTS.outputDir;
          await this.plugin.saveAll();
        }),
      );

    containerEl.createEl('h3', { text: '盯采节奏' });
    new Setting(containerEl)
      .setName('轮询间隔（分钟）')
      .setDesc('下限 15 分钟；公众号发文是小时级，30 分钟即准实时')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.intervalMin)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.intervalMin = Math.max(MIN_INTERVAL, Math.round(n));
            await this.plugin.saveAll();
          }
        }),
      );

    new Setting(containerEl)
      .setName('每号检查条数 / 翻页数')
      .setDesc('每页 20 条；翻页越多越耗请求')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.pages)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.pages = Math.min(5, Math.round(n));
            await this.plugin.saveAll();
          }
        }),
      );

    new Setting(containerEl)
      .setName('单轮上限 / 每号上限')
      .setDesc('控制单轮落盘量，避免一次性抓太多')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxPerRun)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.maxPerRun = Math.min(30, Math.round(n));
            await this.plugin.saveAll();
          }
        }),
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxPerAccount)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.maxPerAccount = Math.min(10, Math.round(n));
            await this.plugin.saveAll();
          }
        }),
      );

    new Setting(containerEl)
      .setName('图片本地化')
      .setDesc('下载正文图片到库内 assets，避免外链失效')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.downloadImages).onChange(async (v) => {
          this.plugin.settings.downloadImages = v;
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl)
      .setName('启动时自动盯采')
      .setDesc('Obsidian 打开后自动开始轮询')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoStart).onChange(async (v) => {
          this.plugin.settings.autoStart = v;
          await this.plugin.saveAll();
        }),
      );

    /* 4. AI 模型 */
    containerEl.createEl('h3', { text: 'AI 模型（可选）' });
    const llm = this.plugin.settings.llm;

    new Setting(containerEl)
      .setName('服务商')
      .setDesc(PROVIDERS[llm.provider]?.note ?? '任何 OpenAI 兼容端点')
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PROVIDERS)) d.addOption(id, p.label);
        d.setValue(llm.provider);
        d.onChange(async (v) => {
          llm.provider = v as ProviderId;
          const preset = PROVIDERS[v as ProviderId];
          if (preset?.baseUrl) llm.baseUrl = preset.baseUrl;
          if (preset?.model) llm.model = preset.model;
          await this.plugin.saveAll();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('OpenAI 兼容地址，例如 https://api.deepseek.com/v1')
      .addText((t) =>
        t.setValue(llm.baseUrl).onChange(async (v) => {
          llm.baseUrl = v.trim();
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('只存在本库插件数据里；本地 Ollama 可留空')
      .addText((t) => {
        t.setValue(llm.apiKey);
        t.inputEl.type = 'password';
        t.onChange(async (v) => {
          llm.apiKey = v.trim();
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName('模型名')
      .addText((t) =>
        t.setValue(llm.model).onChange(async (v) => {
          llm.model = v.trim();
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl)
      .setName('温度 / 最大输出')
      .addText((t) =>
        t.setValue(String(llm.temperature)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 2) {
            llm.temperature = n;
            await this.plugin.saveAll();
          }
        }),
      )
      .addText((t) =>
        t.setValue(String(llm.maxTokens)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 64) {
            llm.maxTokens = Math.min(8000, Math.round(n));
            await this.plugin.saveAll();
          }
        }),
      );

    new Setting(containerEl)
      .setName('每日调用上限')
      .setDesc(`今天已用 ${this.plugin.state.llmQuota?.count ?? 0} 次`)
      .addText((t) =>
        t.setValue(String(llm.dailyCallLimit)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            llm.dailyCallLimit = Math.round(n);
            await this.plugin.saveAll();
          }
        }),
      );

    new Setting(containerEl)
      .setName('入库自动摘要')
      .setDesc('默认关。开启后每篇归档完成自动调一次模型（约 ¥0.01/篇）')
      .addToggle((t) =>
        t.setValue(llm.autoSummarize).onChange(async (v) => {
          llm.autoSummarize = v;
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl).setName('测试连接').addButton((b) =>
      b.setButtonText('测一下').onClick(async () => {
        new Notice('测试中…', 3000);
        new Notice(await this.plugin.testLLMConnection(), 8000);
      }),
    );

    /* 5. 状态 */
    containerEl.createEl('h3', { text: '状态' });
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

    new Setting(containerEl)
      .setName('立即抓取一轮')
      .addButton((b) =>
        b
          .setButtonText('抓取')
          .setCta()
          .onClick(() => void this.plugin.runOnce(true)),
      )
      .addButton((b) =>
        b.setButtonText('清空已归档记录').onClick(async () => {
          this.plugin.state.processed = {};
          await this.plugin.saveAll();
          new Notice('已清空（不会删除已有笔记，但会重复抓取）');
          this.display();
        }),
      );
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
        const frag = document.createDocumentFragment();
        for (const a of items.slice(i, i + chunk)) {
          const label = document.createElement('label');
          label.className = 'wmc-pick-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = picked.has(a.bookId);
          cb.addEventListener('change', () => void toggle(a, cb.checked));
          const nm = document.createElement('span');
          nm.className = 'wmc-pick-name';
          nm.textContent = a.name;
          const id = document.createElement('span');
          id.className = 'wmc-pick-id';
          id.textContent = a.bookId.replace('MP_WXS_', '#');
          label.appendChild(cb);
          label.appendChild(nm);
          label.appendChild(id);
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

    new Setting(wrap)
      .setName('批量操作')
      .setDesc('只作用于当前搜索结果')
      .addButton((b) =>
        b.setButtonText('全选结果').onClick(async () => {
          const items = shelf.filter((a) => !filter || a.name.toLowerCase().includes(filter) || a.bookId.includes(filter));
          for (const a of items) {
            if (!picked.has(a.bookId)) {
              plug.settings.accounts.push(a);
              picked.add(a.bookId);
            }
          }
          await plug.saveAll();
          syncCount();
          draw();
        }),
      )
      .addButton((b) =>
        b.setButtonText('清空').onClick(async () => {
          plug.settings.accounts = [];
          picked.clear();
          await plug.saveAll();
          syncCount();
          draw();
        }),
      );
  }

  private parseAccounts(raw: string): AccountRef[] {
    const out: AccountRef[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const m = /MP_WXS_\d+/.exec(s);
      if (!m) continue;
      const bookId = m[0];
      let name = s.replace(m[0], '').replace(/[|｜,，\t]+/g, ' ').trim();
      if (!name) name = bookId;
      out.push({ name, bookId });
    }
    return out;
  }
}
