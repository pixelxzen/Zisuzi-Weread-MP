import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
import type { WatchStatus } from '../main';
import { AGENT_PRESETS } from '../main';
import { BackfillModal } from './backfill-modal';

export const VIEW_TYPE_WMC = 'wmc-library';

export interface RowItem {
  reviewId: string;
  title: string;
  account: string;
  time: number;
  readNum?: number;
  likeNum?: number;
  picUrl?: string;
  localCover?: string;
  archived: boolean;
  path?: string;
  read: boolean;
  summary?: string;
}

type Mode = 'list' | 'detail' | 'stats' | 'agent';
type Tab = 'body' | 'ai' | 'origin';
type Layout = 'card' | 'feed' | 'official' | 'compact';
type ReadFilter = 'all' | 'unread';
type ArchFilter = 'all' | 'archived' | 'pending';

const LAYOUT_LABEL: Record<Layout, string> = {
  card: '卡片网格',
  feed: '信息流',
  official: '公众号列表',
  compact: '纯标题',
};
const LAYOUT_ICON: Record<Layout, string> = {
  card: 'layout-grid',
  feed: 'columns-2',
  official: 'layout-list',
  compact: 'align-left',
};

function fmtDay(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayGroup(sec: number): string {
  const now = new Date();
  const d = new Date(sec * 1000);
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= day0) return '今天';
  if (t >= day0 - 86400000) return '昨天';
  if (t >= day0 - 7 * 86400000) return '本周';
  if (t >= day0 - 30 * 86400000) return '本月';
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear ? `${d.getMonth() + 1} 月` : `${d.getFullYear()} 年`;
}

export class WmcView extends ItemView {
  private plugin: WereadMpCatcher;
  private mode: Mode = 'list';
  private account = '';
  private readFilter: ReadFilter = 'all';
  private archFilter: ArchFilter = 'all';
  private query = '';
  private selected: RowItem | null = null;
  private tab: Tab = 'body';
  private filling = false;
  private unsubWatch: (() => void) | null = null;
  private logOpen = false;
  private panelQuery = '';
  private agentOut = '';
  private agentBusy = false;
  private selectedIds = new Set<string>();

  private get panelOpen(): boolean {
    return !!this.plugin.settings.panelOpen;
  }
  private set panelOpen(v: boolean) {
    this.plugin.settings.panelOpen = v;
    void this.plugin.saveAll();
  }

  constructor(leaf: WorkspaceLeaf, plugin: WereadMpCatcher) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_WMC;
  }
  getDisplayText(): string {
    return '微信读书公众号';
  }
  getIcon(): string {
    return 'rss';
  }

  async onOpen(): Promise<void> {
    // 清掉 leaf 容器里由 setViewState 重建实例遗留的旧 .wmc-root（否则 DOM 叠加成多面板）
    const host = this.containerEl?.parentElement;
    host?.querySelectorAll('.wmc-root').forEach((el) => {
      if (el !== this.contentEl) el.remove();
    });
    this.contentEl.empty();
    this.contentEl.addClass('wmc-root');
    this.applyTheme();
    this.render();
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onKey(ev));
    // 盯采状态：事件即时刷新 + 1s 兜底（倒计时）
    this.unsubWatch = this.plugin.onWatch(() => this.refreshWatchbar());
    this.registerInterval(window.setInterval(() => this.refreshWatchbar(), 1000));
  }
  async onClose(): Promise<void> {
    this.unsubWatch?.();
    this.unsubWatch = null;
    this.contentEl.empty();
  }

  private applyTheme(): void {
    const t = this.plugin.settings.theme || 'linear';
    this.contentEl.removeClass('wmc-theme-linear');
    this.contentEl.removeClass('wmc-theme-brand');
    this.contentEl.addClass(`wmc-theme-${t}`);
  }

  private get layout(): Layout {
    return (this.plugin.settings.layout || 'card') as Layout;
  }

  /* ------------------------------- 数据 ------------------------------- */

  private allRows(): RowItem[] {
    const p = this.plugin;
    const discovered = p.state.discovered || {};
    const processed = p.state.processed || {};
    const readMap = p.state.read || {};
    const sums = p.state.summaries || {};
    const out: RowItem[] = [];
    const push = (
      rid: string,
      d: { account: string; title: string; time: number; readNum?: number; likeNum?: number; picUrl?: string; localCover?: string },
    ) => {
      const done = processed[rid];
      out.push({
        reviewId: rid,
        title: d.title,
        account: d.account,
        time: d.time,
        readNum: d.readNum,
        likeNum: d.likeNum,
        picUrl: d.picUrl,
        localCover: d.localCover,
        archived: !!done,
        path: done?.path,
        read: !!readMap[rid],
        summary: sums[rid],
      });
    };
    for (const [rid, d] of Object.entries(discovered)) push(rid, d);
    for (const [rid, v] of Object.entries(processed)) {
      if (!discovered[rid]) push(rid, { account: v.account, title: v.title, time: v.time });
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }

  private rows(): RowItem[] {
    const q = this.query.toLowerCase();
    return this.allRows().filter((r) => {
      if (this.account && r.account !== this.account) return false;
      if (this.readFilter === 'unread' && r.read) return false;
      if (this.archFilter === 'archived' && !r.archived) return false;
      if (this.archFilter === 'pending' && r.archived) return false;
      if (q && !r.title.toLowerCase().includes(q) && !r.account.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  private async fillSummaries(rows: RowItem[]): Promise<void> {
    if (this.filling) return;
    const need = rows.filter((r) => r.archived && r.path && !r.summary).slice(0, 50);
    if (!need.length) return;
    this.filling = true;
    if (!this.plugin.state.summaries) this.plugin.state.summaries = {};
    let changed = false;
    for (const r of need) {
      try {
        const md = await this.plugin.readNoteBody(r.path!);
        const text = md
          .replace(/!\[[^\]]*\]\(<[^>]*>\)/g, '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/<[^>]+>/g, '')
          .replace(/[#>*`_~-]+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          this.plugin.state.summaries[r.reviewId] = text.slice(0, 90);
          changed = true;
        }
      } catch {
        /* 单篇失败忽略 */
      }
    }
    this.filling = false;
    if (changed) {
      await this.plugin.saveAll();
      this.render();
    }
  }

  /* ------------------------------- 渲染 ------------------------------- */

  render(): void {
    const root = this.contentEl;
    root.empty();
    this.applyTheme();
    if (this.mode === 'list') this.renderList();
    else if (this.mode === 'detail') void this.renderDetail();
    else if (this.mode === 'agent') this.renderAgent();
    else this.renderStats();
  }

  /* --------------------------- 顶部：Linear 式 --------------------------- */

  private header(parent: HTMLElement): void {
    const bar = parent.createDiv('wmc-topbar');
    if (this.mode !== 'list') {
      this.iconBtn(bar, 'arrow-left', '返回', () => {
        this.mode = 'list';
        this.selected = null;
        this.render();
      });
    }
    const title = bar.createDiv('wmc-topbar-title');
    title.setText(this.mode === 'list' ? '微信读书公众号' : this.mode === 'stats' ? '盯采统计' : '文章');

    bar.createDiv('wmc-spacer').style.flex = '1';

    // 勾选 → 只下载所选
    const pickBar = bar.createDiv('wmc-pickbar');
    const pickBtn = pickBar.createEl('button', {
      cls: 'wmc-pickbar-btn',
      text: this.selectedIds.size ? `下载所选 ${this.selectedIds.size} 篇` : '下载所选',
    });
    (pickBtn as HTMLButtonElement).disabled = this.selectedIds.size === 0;
    pickBtn.addEventListener('click', () => void this.downloadSelected());
    pickBar.createSpan({
      cls: 'wmc-pickbar-count',
      text: this.selectedIds.size ? `已选 ${this.selectedIds.size} 篇` : '勾选文章后可只下载它们',
    });
    if (this.selectedIds.size) {
      const clr = pickBar.createSpan({ cls: 'wmc-pickbar-clear', text: '清空' });
      clr.addEventListener('click', () => {
        this.selectedIds.clear();
        this.renderList();
      });
    }

    this.iconBtn(bar, 'bot', '本地 Agent', () => {
      this.mode = this.mode === 'agent' ? 'list' : 'agent';
      this.render();
    });
    this.iconBtn(bar, 'radar', this.panelOpen ? '关闭盯采管理' : '盯采管理', () => {
      this.panelOpen = !this.panelOpen;
      this.render();
    });

    this.iconBtn(bar, 'refresh-cw', '抓取一轮', () => void this.plugin.runOnce(true).then(() => this.render()), true);
    this.iconBtn(bar, 'archive', '归档某个号的全部历史', () =>
      new BackfillModal(this.app, this.plugin, this.account || undefined).open(),
    );
    this.iconBtn(bar, 'bar-chart-3', '盯采统计', () => {
      this.mode = this.mode === 'stats' ? 'list' : 'stats';
      this.render();
    });
    this.iconBtn(bar, this.plugin.isWatching() ? 'pause' : 'play', this.plugin.isWatching() ? '停止盯采' : '开始盯采', () => {
      this.plugin.toggleWatchFromView();
      this.render();
    });
    this.iconBtn(bar, 'settings-2', '设置', () => {
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.('weread-mp-catcher');
    });
  }

  private toolbar(parent: HTMLElement): void {
    const bar = parent.createDiv('wmc-toolbar');

    const search = bar.createDiv('wmc-searchbox');
    const ico = search.createSpan('wmc-searchbox-ico');
    setIcon(ico, 'search');
    const input = search.createEl('input', { type: 'search', placeholder: '搜索公众号或标题…' });
    input.value = this.query;
    input.addEventListener('input', () => {
      this.query = input.value.trim();
      if (this.mode === 'list') this.renderList();
    });

    const mkSelect = (label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
      const sel = bar.createEl('select', { cls: 'wmc-select' });
      for (const [v, l] of options) {
        const o = sel.createEl('option', { text: l });
        o.value = v;
      }
      sel.value = value;
      sel.setAttr('title', label);
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };

    const accounts: Array<[string, string]> = [['', '全部公众号'], ...this.plugin.accountNames().map((n): [string, string] => [n, n])];
    mkSelect('按公众号筛选', accounts, this.account, (v) => {
      this.account = v;
      this.renderList();
      // 选中的号还没有任何文章 → 自动拉它的列表（避免空白）
      if (v && !this.allRows().some((r) => r.account === v)) {
        void this.plugin.fetchAccountList(v);
      }
    });
    mkSelect('已归档状态', [['all', '全部状态'], ['archived', '已归档'], ['pending', '未归档']] as Array<[string, string]>, this.archFilter, (v) => {
      this.archFilter = v as ArchFilter;
      this.renderList();
    });
    mkSelect('已读状态', [['all', '未读+已读'], ['unread', '仅未读']] as Array<[string, string]>, this.readFilter, (v) => {
      this.readFilter = v as ReadFilter;
      this.renderList();
    });

    bar.createDiv('wmc-spacer').style.flex = '1';

    const layouts: Layout[] = ['card', 'feed', 'official', 'compact'];
    for (const l of layouts) {
      const b = bar.createEl('button', { cls: `wmc-seg${this.layout === l ? ' is-active' : ''}` });
      setIcon(b, LAYOUT_ICON[l]);
      b.setAttr('title', LAYOUT_LABEL[l]);
      b.addEventListener('click', () => {
        this.plugin.settings.layout = l;
        void this.plugin.saveAll();
        this.render();
      });
    }
  }

  private statbar(parent: HTMLElement, rows: RowItem[]): void {
    const all = this.allRows();
    const archived = all.filter((r) => r.archived).length;
    const accounts = new Set(all.map((r) => r.account)).size;
    const week = all.filter((r) => r.time >= Date.now() / 1000 - 7 * 86400).length;
    const subs = this.plugin.settings.shelfAccounts.length || this.plugin.settings.accounts.length;

    const bar = parent.createDiv('wmc-statbar');
    const item = (icon: string, value: string, label: string) => {
      const el = bar.createDiv('wmc-statbar-item');
      const chip = el.createSpan('wmc-statbar-chip');
      setIcon(chip, icon);
      const col = el.createSpan('wmc-statbar-col');
      col.createSpan({ cls: 'wmc-statbar-value', text: value });
      col.createSpan({ cls: 'wmc-statbar-label', text: label });
    };
    item('book-open', String(subs), '订阅');
    item('file-check-2', String(archived), '已归档');
    item('layers', String(accounts), '覆盖号');
    item('trending-up', String(week), '本周');
    if (rows.length !== all.length) {
      const el = bar.createDiv('wmc-statbar-filtered');
      el.setText(`筛选中 · ${rows.length} 篇`);
    }
  }

  /* ------------------------- 盯采状态条 + 日志 ------------------------- */

  private watchbar(parent: HTMLElement): void {
    const s = this.plugin.getWatchStatus();
    if (!s.running && !s.busy && !s.lastRunAt && !s.log.length) return; // 完全没用过就不显示
    const bar = parent.createDiv('wmc-watchbar');
    bar.createDiv('wmc-watch-dot');
    const main = bar.createDiv('wmc-watch-main');
    main.createDiv('wmc-watch-text');
    main.createDiv('wmc-progress').createDiv('wmc-progress-fill');
    const actions = bar.createDiv('wmc-watch-actions');
    this.iconBtn(actions, 'zap', '立即抓取一轮', () => void this.plugin.runOnce(true));
    const stopBtn = this.iconBtn(
      actions,
      s.busy ? 'square' : s.running ? 'pause' : 'play',
      s.busy ? '停止盯采' : s.running ? '暂停盯采' : '开始盯采',
      () => {
        this.plugin.toggleWatchFromView();
        this.refreshWatchbar();
      },
    );
    if (s.busy || s.running) stopBtn.addClass('is-live');
    this.iconBtn(actions, 'scroll-text', this.logOpen ? '收起日志' : '盯采日志', () => {
      this.logOpen = !this.logOpen;
      this.render();
    });
    if (this.logOpen) this.renderWatchLog(parent, s);
    this.refreshWatchbar();
  }

  private renderWatchLog(parent: HTMLElement, s: WatchStatus): void {
    const panel = parent.createDiv('wmc-watchlog');
    const items = s.log.slice(-15).reverse();
    if (!items.length) {
      panel.createDiv({ cls: 'wmc-hint', text: '还没有日志。' });
      return;
    }
    const p = (n: number) => String(n).padStart(2, '0');
    const LOG_ICON: Record<string, string> = { info: 'circle', ok: 'check', warn: 'alert-triangle', err: 'x-circle' };
    for (const it of items) {
      const row = panel.createDiv(`wmc-watchlog-row is-${it.kind}`);
      const ico = row.createSpan('wmc-watchlog-ico');
      setIcon(ico, LOG_ICON[it.kind] || 'circle');
      const d = new Date(it.at);
      row.createSpan({ cls: 'wmc-watchlog-time', text: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` });
      row.createSpan({ cls: 'wmc-watchlog-text', text: it.text });
    }
  }

  private refreshWatchbar(): void {
    const bar = this.contentEl.querySelector('.wmc-watchbar');
    if (!bar) return;
    const s = this.plugin.getWatchStatus();
    const dot = bar.querySelector('.wmc-watch-dot');
    const text = bar.querySelector('.wmc-watch-text') as HTMLElement | null;
    const fill = bar.querySelector('.wmc-progress-fill') as HTMLElement | null;
    if (!dot || !text || !fill) return;

    let mode: 'busy' | 'idle' | 'error' | 'off' = 'off';
    let t = '';
    let pct = 0;

    if (s.busy) {
      mode = 'busy';
      if (s.phase === 'list') {
        pct = s.accountTotal ? s.accountIndex / s.accountTotal : 0;
        t = `正在看「${s.account || '…'}」（第 ${s.accountIndex}/${s.accountTotal} 个号）`;
      } else {
        pct = s.queueTotal ? (s.written + s.skipped) / s.queueTotal : 0;
        t = `正在存「${s.account || '…'}」的文章（${s.written + s.skipped}/${s.queueTotal} 篇）`;
      }
    } else if (s.lastError) {
      mode = 'error';
      pct = 1;
      t = /2012|风控|登录/.test(s.lastError) ? '登录过期了 — 去设置里重新扫码就能继续' : `出错了：${s.lastError}`;
    } else if (s.running) {
      mode = 'idle';
      const intervalMs = Math.max(15, this.plugin.settings.intervalMin || 30) * 60000;
      const remain = s.nextRunAt ? Math.max(0, s.nextRunAt - Date.now()) : 0;
      pct = intervalMs ? Math.min(1, Math.max(0, 1 - remain / intervalMs)) : 0;
      const m = Math.floor(remain / 60000);
      const sec = Math.floor((remain % 60000) / 1000);
      t = `自动更新中 · ${m} 分 ${sec} 秒后看下一轮${s.lastRunAt ? ` · 上次收了 ${s.written} 篇` : ''}`;
    } else if (s.lastRunAt) {
      const d = new Date(s.lastRunAt);
      const p = (n: number) => String(n).padStart(2, '0');
      t = `自动更新已暂停 · 上次 ${p(d.getHours())}:${p(d.getMinutes())} 收了 ${s.written} 篇`;
      pct = 1;
    } else {
      t = '自动更新还没开启 — 点右边 ▶ 开始';
    }

    dot.className = `wmc-watch-dot is-${mode === 'busy' ? 'busy' : mode === 'idle' ? 'idle' : mode === 'error' ? 'error' : 'off'}`;
    fill.className = `wmc-progress-fill is-${mode}`;
    fill.style.width = `${Math.round(pct * 100)}%`;
    text.setText(t);
  }

  /* ------------------------- 盯采管理面板（抽屉） ------------------------- */

  private renderPanel(root: HTMLElement): void {
    const panel = root.createDiv('wmc-panel');
    const head = panel.createDiv('wmc-panel-head');
    head.createSpan({ cls: 'wmc-panel-title', text: '盯采管理' });
    const watchedCount = this.plugin.settings.accounts.length;
    head.createSpan({ cls: 'wmc-panel-count', text: `${watchedCount} 个号` });
    const close = head.createEl('button', { cls: 'wmc-icon-btn' });
    setIcon(close, 'x');
    close.setAttr('title', '关闭');
    close.addEventListener('click', () => {
      this.panelOpen = false;
      this.render();
    });

    const searchRow = panel.createDiv('wmc-panel-search');
    const sInput = searchRow.createEl('input', { type: 'search', placeholder: '搜索公众号…' });
    sInput.value = this.panelQuery;
    sInput.addEventListener('input', () => {
      this.panelQuery = sInput.value.trim();
      this.refreshPanelList();
    });

    const batch = panel.createDiv('wmc-panel-batch');
    const selAll = batch.createEl('button', { cls: 'wmc-panel-btn', text: '全选结果' });
    selAll.addEventListener('click', () => this.panelSelectAll(true));
    const clear = batch.createEl('button', { cls: 'wmc-panel-btn', text: '清空' });
    clear.addEventListener('click', () => this.panelSelectAll(false));

    const list = panel.createDiv('wmc-panel-list');
    this.renderPanelList(list);
  }

  private panelAccounts(): Array<{ name: string; bookId: string }> {
    const shelf = this.plugin.settings.shelfAccounts;
    const q = this.panelQuery.toLowerCase();
    if (!q) return shelf;
    return shelf.filter((a) => a.name.toLowerCase().includes(q));
  }

  private renderPanelList(list: HTMLElement): void {
    list.empty();
    const accounts = this.panelAccounts();
    const watched = new Set(this.plugin.settings.accounts.map((a) => a.bookId));
    for (const acc of accounts) {
      const row = list.createDiv('wmc-panel-row');
      const cb = row.createEl('input', { type: 'checkbox' });
      cb.checked = watched.has(acc.bookId);
      cb.addEventListener('change', () => this.toggleWatch(acc, cb.checked));
      row.createSpan({ cls: 'wmc-panel-name', text: acc.name });
      const last = this.lastTimeFor(acc.name);
      if (last) row.createSpan({ cls: 'wmc-panel-time', text: last });
    }
    if (!accounts.length) {
      list.createDiv({ cls: 'wmc-hint', text: '没有匹配的公众号。' });
    }
  }

  private refreshPanelList(): void {
    const list = this.contentEl.querySelector('.wmc-panel-list') as HTMLElement | null;
    if (list) this.renderPanelList(list);
  }

  private lastTimeFor(account: string): string {
    let max = 0;
    for (const r of this.allRows()) {
      if (r.account === account && r.time > max) max = r.time;
    }
    if (!max) return '';
    const diff = Date.now() - max * 1000;
    if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  private toggleWatch(acc: { name: string; bookId: string }, on: boolean): void {
    if (on) {
      if (!this.plugin.settings.accounts.some((a) => a.bookId === acc.bookId)) {
        this.plugin.settings.accounts.push(acc);
      }
    } else {
      this.plugin.settings.accounts = this.plugin.settings.accounts.filter((a) => a.bookId !== acc.bookId);
    }
    void this.plugin.saveAll();
  }

  private panelSelectAll(on: boolean): void {
    const accounts = this.panelAccounts();
    if (on) {
      const existing = new Set(this.plugin.settings.accounts.map((a) => a.bookId));
      for (const a of accounts) {
        if (!existing.has(a.bookId)) this.plugin.settings.accounts.push(a);
      }
    } else {
      const ids = new Set(accounts.map((a) => a.bookId));
      this.plugin.settings.accounts = this.plugin.settings.accounts.filter((a) => !ids.has(a.bookId));
    }
    void this.plugin.saveAll();
    this.refreshPanelList();
    new Notice(on ? `已选中 ${accounts.length} 个号` : `已清空 ${accounts.length} 个号`);
  }

  private iconBtn(parent: HTMLElement, icon: string, label: string, onClick: () => void, cta = false): HTMLElement {
    const b = parent.createEl('button', { cls: `wmc-icon-btn${cta ? ' is-cta' : ''}` });
    setIcon(b, icon);
    b.setAttr('aria-label', label);
    b.setAttr('title', label);
    b.addEventListener('click', onClick);
    return b;
  }

  /* ------------------------------ 列表 ------------------------------ */

  private renderList(): void {
    const root = this.contentEl;
    root.empty(); // 搜索 input/筛选 onChange 直接调本函数，必须先清，否则每击一键叠加一份
    this.header(root);
    this.toolbar(root);
    const rows = this.rows();
    this.statbar(root, rows);
    this.watchbar(root);
    if (this.panelOpen) this.renderPanel(root);

    if (!rows.length) {
      this.renderEmpty(root);
      return;
    }

    const scroller = root.createDiv('wmc-scroll');
    const groups = new Map<string, RowItem[]>();
    for (const r of rows) {
      const g = dayGroup(r.time);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    }

    const cls =
      this.layout === 'card' ? 'wmc-grid' : this.layout === 'feed' ? 'wmc-feed' : this.layout === 'official' ? 'wmc-official' : 'wmc-compact';

    for (const [group, items] of groups) {
      const sec = scroller.createDiv('wmc-group');
      const h = sec.createDiv('wmc-group-head');
      h.createSpan({ cls: 'wmc-group-title', text: group });
      h.createSpan({ cls: 'wmc-group-count', text: String(items.length) });
      const box = sec.createDiv(cls);
      let i = 0;
      const chunk = this.layout === 'compact' || this.layout === 'official' ? 120 : 60;
      const step = () => {
        const frag = document.createDocumentFragment();
        for (const r of items.slice(i, i + chunk)) frag.appendChild(this.item(r));
        i += chunk;
        box.appendChild(frag);
        if (i < items.length) window.setTimeout(step, 0);
      };
      step();
    }
    void this.fillSummaries(rows);
    // 搜索框正在打字时，empty+重建会失焦 → 恢复焦点到末尾
    if (this.query) {
      const inp = root.querySelector<HTMLInputElement>('.wmc-searchbox input');
      if (inp && document.activeElement !== inp) {
        inp.focus();
        const len = inp.value.length;
        inp.setSelectionRange(len, len);
      }
    }
  }

  /* ------------------------- 空态 = 新手引导 ------------------------- */

  private renderEmpty(root: HTMLElement): void {
    const loggedIn = !!this.plugin.settings.cookie;
    const hasAccounts = this.plugin.settings.accounts.length > 0;
    const filtering = !!(this.query || this.account || this.archFilter !== 'all' || this.readFilter !== 'all');

    const wrap = root.createDiv('wmc-hero');
    const ico = wrap.createDiv('wmc-hero-icon');
    setIcon(ico, filtering ? 'search-x' : loggedIn ? 'newspaper' : 'key-round');

    if (!loggedIn) {
      wrap.createDiv({ cls: 'wmc-hero-title', text: '把公众号新文章自动存进 Obsidian' });
      wrap.createDiv({ cls: 'wmc-hero-sub', text: '扫码登录微信读书就能开始，不用复制任何东西' });
      this.heroBtn(wrap, '① 扫码登录', true, () => this.plugin.startQrLogin());
      return;
    }
    if (!hasAccounts) {
      wrap.createDiv({ cls: 'wmc-hero-title', text: '先告诉我要盯哪些公众号' });
      wrap.createDiv({ cls: 'wmc-hero-sub', text: '从你微信读书的书架里勾选想追的号，我会自动收集它们的新文章' });
      this.heroBtn(wrap, '去选择公众号', true, () => {
        this.panelOpen = true;
        this.render();
      });
      return;
    }
    if (filtering) {
      wrap.createDiv({ cls: 'wmc-hero-title', text: '这样筛选没有文章' });
      wrap.createDiv({ cls: 'wmc-hero-sub', text: '换个关键词，或者清除筛选条件看看全部' });
      this.heroBtn(wrap, '清除筛选，看全部', false, () => {
        this.query = '';
        this.account = '';
        this.archFilter = 'all';
        this.readFilter = 'all';
        this.render();
      });
      return;
    }
    wrap.createDiv({ cls: 'wmc-hero-title', text: '还没有收集到文章' });
    wrap.createDiv({ cls: 'wmc-hero-sub', text: '点下面的按钮，马上抓第一轮（只抓你勾选的公众号）' });
    const row = wrap.createDiv('wmc-hero-btns');
    this.heroBtn(row, '立即抓取第一轮', true, () => void this.plugin.runOnce(true).then(() => this.render()));
    this.heroBtn(row, '调整要盯的号', false, () => {
      this.panelOpen = true;
      this.render();
    });
  }

  private heroBtn(parent: HTMLElement, text: string, primary: boolean, onClick: () => void): void {
    const b = parent.createEl('button', { cls: `wmc-hero-btn${primary ? ' is-primary' : ''}`, text });
    b.addEventListener('click', onClick);
  }

  /* ------------------------------ 本地 Agent ------------------------------ */

  private renderAgent(): void {
    const root = this.contentEl;
    this.header(root);
    const cfg = this.plugin.settings.agent;
    const label = (AGENT_PRESETS.find((p) => p.id === cfg.preset) || AGENT_PRESETS[0]).label;

    const wrap = root.createDiv('wmc-agent');
    const bar = wrap.createDiv('wmc-agent-bar');
    const who = bar.createSpan('wmc-agent-who');
    const ico = who.createSpan('wmc-agent-ico');
    setIcon(ico, 'bot');
    who.createSpan({ text: `本地 Agent · ${label}` });
    bar.createSpan({ cls: 'wmc-agent-hint', text: '在设置 → 本地 Agent 里可切换 Hermes / Claude Code / Codex 等' });

    const out = wrap.createDiv('wmc-agent-out');
    out.setText(this.agentOut || '在下面提问。Agent 会直接在你的库里动手：读笔记、写笔记、跑命令。');

    const inputRow = wrap.createDiv('wmc-agent-input');
    const ta = inputRow.createEl('textarea', {
      cls: 'wmc-agent-textarea',
      placeholder: '例如：把本周 AI 硬件相关的文章整理成一篇综述笔记，放在 5-剪藏笔记 下',
    });
    const send = inputRow.createEl('button', {
      cls: `wmc-hero-btn${this.agentBusy ? '' : ' is-primary'}`,
      text: this.agentBusy ? '运行中…' : '发送',
    });
    (send as HTMLButtonElement).disabled = this.agentBusy;
    send.addEventListener('click', () => void this.runAgentPrompt(ta.value, out));
    ta.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') void this.runAgentPrompt(ta.value, out);
    });
  }

  private async runAgentPrompt(q: string, out: HTMLElement): Promise<void> {
    const prompt = q.trim();
    if (!prompt || this.agentBusy) return;
    this.agentBusy = true;
    this.agentOut = '';
    out.setText('启动中…');
    try {
      const r = await this.plugin.runAgent(prompt, (chunk) => {
        this.agentOut += chunk;
        out.setText(this.agentOut);
        out.scrollTop = out.scrollHeight;
      });
      if (r.code !== 0) {
        const tail = (r.err || '').split('\n').filter(Boolean).slice(-3).join('\n');
        this.agentOut += `\n\n[退出码 ${r.code}]${tail ? `\n${tail}` : ''}`;
      } else if (!this.agentOut.trim()) {
        this.agentOut = '（Agent 没有返回内容）';
      }
      out.setText(this.agentOut);
    } catch (e) {
      this.agentOut = `出错：${e instanceof Error ? e.message : String(e)}`;
      out.setText(this.agentOut);
    }
    this.agentBusy = false;
    const send = this.contentEl.querySelector('.wmc-agent-input button') as HTMLButtonElement | null;
    if (send) {
      send.disabled = false;
      send.setText('发送');
    }
  }

  private item(r: RowItem): HTMLElement {
    const el =
      this.layout === 'feed'
        ? this.feedItem(r)
        : this.layout === 'official'
          ? this.officialRow(r)
          : this.layout === 'compact'
            ? this.compactRow(r)
            : this.card(r);
    // 勾选框：只下载你勾的这几篇
    const cb = el.createEl('input', { type: 'checkbox', cls: 'wmc-pick' });
    cb.checked = this.selectedIds.has(r.reviewId);
    cb.setAttr('title', '勾选后可点「下载所选」只下载这几篇');
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) this.selectedIds.add(r.reviewId);
      else this.selectedIds.delete(r.reviewId);
      this.updatePickBar();
    });
    return el;
  }

  private updatePickBar(): void {
    const btn = this.contentEl.querySelector('.wmc-pickbar-btn') as HTMLButtonElement | null;
    const cnt = this.contentEl.querySelector('.wmc-pickbar-count');
    const n = this.selectedIds.size;
    if (btn) {
      btn.disabled = n === 0;
      btn.setText(n ? `下载所选 ${n} 篇` : '下载所选');
    }
    if (cnt) cnt.setText(n ? `已选 ${n} 篇` : '勾选文章后可只下载它们');
  }

  private async downloadSelected(): Promise<void> {
    const ids = [...this.selectedIds];
    if (!ids.length) return;
    try {
      const r = await this.plugin.archiveMany(ids);
      new Notice(`下载完成：成功 ${r.ok} 篇${r.fail ? `，失败/跳过 ${r.fail}` : ''}`, 9000);
    } catch (e) {
      new Notice(`下载失败：${e instanceof Error ? e.message : String(e)}`, 9000);
    }
    this.selectedIds.clear();
    this.renderList();
  }

  private bindOpen(el: HTMLElement, r: RowItem): void {
    el.addEventListener('click', () => {
      this.plugin.markRead(r.reviewId);
      this.selected = r;
      this.mode = 'detail';
      this.tab = 'body';
      this.render();
    });
  }

  private coverSrc(r: RowItem): string | null {
    if (r.localCover) {
      try {
        return this.app.vault.adapter.getResourcePath(r.localCover);
      } catch {
        /* 回退外链 */
      }
    }
    return r.picUrl || null;
  }

  private card(r: RowItem): HTMLElement {
    const card = createEl('div', { cls: 'wmc-card' });
    if (r.read) card.addClass('is-read');
    const cover = card.createDiv('wmc-card-cover');
    const src = this.coverSrc(r);
    if (src) {
      const img = cover.createEl('img');
      img.src = src;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
    } else {
      cover.createDiv({ cls: 'wmc-card-fallback', text: (r.account || '公').slice(0, 1) });
    }
    if (!r.read) cover.createDiv('wmc-card-dot');
    const body = card.createDiv('wmc-card-body');
    body.createDiv({ cls: 'wmc-card-title', text: r.title });
    if (r.summary) body.createDiv({ cls: 'wmc-card-sum', text: r.summary });
    const foot = body.createDiv('wmc-card-foot');
    foot.createSpan({ cls: 'wmc-card-acc', text: r.account });
    foot.createSpan({ cls: 'wmc-card-date', text: fmtDay(r.time) });
    if (r.archived) card.createDiv('wmc-card-badge').setText('已归档');
    this.bindOpen(card, r);
    return card;
  }

  private feedItem(r: RowItem): HTMLElement {
    const src = this.coverSrc(r);
    const el = createEl('div', { cls: `wmc-feed-item${src ? ' has-img' : ''}${r.read ? ' is-read' : ''}` });
    if (src) {
      const img = el.createEl('img', { cls: 'wmc-feed-img' });
      img.src = src;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
    }
    const body = el.createDiv('wmc-feed-body');
    body.createDiv({ cls: 'wmc-feed-title', text: r.title });
    if (r.summary) body.createDiv({ cls: 'wmc-feed-sum', text: r.summary });
    const meta = body.createDiv('wmc-feed-meta');
    meta.createSpan({ text: r.account });
    meta.createSpan({ text: fmtDay(r.time) });
    if (!r.read) el.createDiv('wmc-feed-dot');
    this.bindOpen(el, r);
    return el;
  }

  private officialRow(r: RowItem): HTMLElement {
    const row = createEl('div', { cls: `wmc-off-row${r.read ? ' is-read' : ''}` });
    const thumb = row.createDiv('wmc-off-thumb');
    const src = this.coverSrc(r);
    if (src) {
      const img = thumb.createEl('img');
      img.src = src;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
    } else {
      thumb.createDiv({ cls: 'wmc-off-fallback', text: (r.account || '公').slice(0, 1) });
    }
    const main = row.createDiv('wmc-off-main');
    main.createDiv({ cls: 'wmc-off-title', text: r.title });
    if (r.summary) main.createDiv({ cls: 'wmc-off-sum', text: r.summary });
    const meta = main.createDiv('wmc-off-meta');
    meta.createSpan({ text: r.account });
    meta.createSpan({ text: fmtDay(r.time) });
    if (r.readNum !== undefined) meta.createSpan({ text: `${r.readNum} 阅读` });
    if (!r.read) row.createDiv('wmc-off-dot');
    this.bindOpen(row, r);
    return row;
  }

  private compactRow(r: RowItem): HTMLElement {
    const row = createEl('div', { cls: `wmc-cmp-row${r.read ? ' is-read' : ''}` });
    const dot = row.createDiv('wmc-cmp-dot');
    setIcon(dot, r.read ? 'circle-check' : 'circle');
    const main = row.createDiv('wmc-cmp-main');
    main.createDiv({ cls: 'wmc-cmp-title', text: r.title });
    const sub = main.createDiv('wmc-cmp-sub');
    sub.setText(`${r.account} · ${fmtDay(r.time)}${r.summary ? ` · ${r.summary.slice(0, 40)}` : ''}`);
    this.bindOpen(row, r);
    return row;
  }

  /* ------------------------------ 详情 ------------------------------ */

  private async renderDetail(): Promise<void> {
    const root = this.contentEl;
    const r = this.selected;
    this.header(root);
    if (!r) {
      root.createDiv('wmc-empty').setText('没有选中的文章');
      return;
    }
    const head = root.createDiv('wmc-detail-head');
    head.createDiv({ cls: 'wmc-detail-title', text: r.title });
    head.createDiv({
      cls: 'wmc-detail-meta',
      text: `${r.account}${r.readNum !== undefined ? ` · 阅读 ${r.readNum}` : ''}${
        r.likeNum !== undefined ? ` · 赞 ${r.likeNum}` : ''
      } · ${fmtDay(r.time)}${r.archived ? ' · 已归档' : ''}`,
    });

    const tabs = root.createDiv('wmc-tabs');
    const mkTab = (id: Tab, label: string) => {
      const t = tabs.createEl('button', { cls: 'wmc-tab', text: label });
      if (this.tab === id) t.addClass('is-active');
      t.addEventListener('click', () => {
        this.tab = id;
        this.render();
      });
    };
    mkTab('body', '正文');
    mkTab('ai', 'AI 摘要');
    mkTab('origin', '原文');

    const body = root.createDiv('wmc-detail-body');

    if (this.tab === 'origin') {
      const a = body.createEl('a', {
        text: '在微信读书打开原文 →',
        href: `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(r.reviewId)}`,
      });
      a.setAttr('target', '_blank');
      body.createDiv({ cls: 'wmc-hint', text: '需已登录微信读书网页版。' });
      return;
    }

    if (this.tab === 'ai') {
      if (!r.archived || !r.path) {
        body.createDiv('wmc-hint').setText('先归档这篇，再生成摘要。');
        return;
      }
      const md = await this.plugin.readNoteBody(r.path);
      const idx = md.indexOf('## AI 摘要');
      if (idx >= 0) {
        body.addClass('markdown-rendered');
        await MarkdownRenderer.render(this.app, md.slice(idx), body, r.path, this);
        const redo = body.createEl('button', { cls: 'wmc-text-btn', text: '重新生成' });
        redo.addEventListener('click', () => void this.doAi(r));
      } else {
        body.createDiv('wmc-hint').setText('还没有摘要。');
        const btn = body.createEl('button', { cls: 'wmc-text-btn is-primary', text: '生成 AI 摘要' });
        btn.addEventListener('click', () => void this.doAi(r));
      }
      return;
    }

    if (r.archived && r.path) {
      const f = this.app.vault.getAbstractFileByPath(r.path);
      if (f) {
        const md = await this.app.vault.cachedRead(f as any);
        body.addClass('markdown-rendered');
        await MarkdownRenderer.render(this.app, md, body, r.path, this);
        return;
      }
    }
    body.createDiv('wmc-hint').setText('这篇还没归档。');
    const btn = body.createEl('button', { cls: 'wmc-text-btn is-primary', text: '抓取并归档' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.setText('抓取中…');
      const ok = await this.plugin.archiveSingle(r.reviewId, r.account);
      btn.disabled = false;
      if (ok) {
        const fresh = this.rows().find((x) => x.reviewId === r.reviewId);
        if (fresh) {
          this.selected = fresh;
          this.render();
        }
      } else {
        btn.setText('失败，重试');
      }
    });
  }

  private async doAi(r: RowItem): Promise<void> {
    if (!r.path) return;
    const t = new Notice('AI 总结中…', 0);
    try {
      const body = await this.plugin.readNoteBody(r.path);
      const ok = await this.plugin.aiSummarizeNote(r.path, r.title, body);
      t.hide();
      new Notice(ok ? '摘要已写入笔记' : '摘要失败');
      if (ok) this.render();
    } catch (e) {
      t.hide();
      new Notice(`AI 失败：${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  /* ------------------------------ 统计 ------------------------------ */

  private renderStats(): void {
    const root = this.contentEl;
    this.header(root);
    const all = this.allRows();
    const byAcc = new Map<string, number>();
    for (const r of all) byAcc.set(r.account, (byAcc.get(r.account) || 0) + 1);
    const week = all.filter((r) => r.time >= Date.now() / 1000 - 7 * 86400).length;
    const archived = all.filter((r) => r.archived).length;

    const wrap = root.createDiv('wmc-stats');
    const cards = wrap.createDiv('wmc-stat-cards');
    const card = (label: string, value: string) => {
      const c = cards.createDiv('wmc-stat-card');
      c.createDiv({ cls: 'wmc-stat-value', text: value });
      c.createDiv({ cls: 'wmc-stat-label', text: label });
    };
    card('总篇数', String(all.length));
    card('本周新增', String(week));
    card('已归档', String(archived));
    card('覆盖公众号', String(byAcc.size));

    const top = [...byAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max = top[0]?.[1] || 1;
    const list = wrap.createDiv('wmc-stat-list');
    list.createDiv({ cls: 'wmc-stat-list-title', text: '各号篇数（Top 12）' });
    for (const [acc, n] of top) {
      const row = list.createDiv('wmc-stat-row');
      row.createSpan({ cls: 'wmc-stat-row-name', text: acc });
      const track = row.createDiv('wmc-stat-track');
      track.createDiv('wmc-stat-fill').style.width = `${Math.round((n / max) * 100)}%`;
      row.createSpan({ cls: 'wmc-stat-row-num', text: String(n) });
    }
    if (!top.length) list.createDiv({ cls: 'wmc-hint', text: '还没有数据，先抓一轮。' });
  }

  /* ------------------------------ 键盘 ------------------------------ */

  private onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.mode !== 'list') {
      if (ev.key === 'Escape') {
        this.mode = 'list';
        this.render();
      }
      return;
    }
    const rows = this.rows();
    if (!rows.length) return;
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const idx = this.selected ? rows.findIndex((r) => r.reviewId === this.selected!.reviewId) : -1;
      const next = rows[Math.min(rows.length - 1, idx < 0 ? 0 : idx + 1)];
      if (next) {
        this.selected = next;
        this.mode = 'detail';
        this.render();
      }
    } else if (ev.key === '/') {
      ev.preventDefault();
      (this.contentEl.querySelector('.wmc-searchbox input') as HTMLInputElement | null)?.focus();
    }
  }
}
