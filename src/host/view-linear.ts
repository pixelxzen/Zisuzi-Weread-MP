import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
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
  archived: boolean;
  path?: string;
  read: boolean;
  summary?: string;
}

type Mode = 'list' | 'detail' | 'stats';
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
    this.contentEl.addClass('wmc-root');
    this.applyTheme();
    this.render();
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onKey(ev));
  }
  async onClose(): Promise<void> {
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
      d: { account: string; title: string; time: number; readNum?: number; likeNum?: number; picUrl?: string },
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
      const i = el.createSpan('wmc-statbar-ico');
      setIcon(i, icon);
      el.createSpan({ cls: 'wmc-statbar-value', text: value });
      el.createSpan({ cls: 'wmc-statbar-label', text: label });
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
    this.header(root);
    this.toolbar(root);
    const rows = this.rows();
    this.statbar(root, rows);

    if (!rows.length) {
      const e = root.createDiv('wmc-empty');
      e.setText(
        this.plugin.settings.cookie
          ? this.query || this.account || this.archFilter !== 'all' || this.readFilter !== 'all'
            ? '没有符合筛选条件的文章。'
            : '还没有文章。点右上角刷新抓一轮，或去设置勾选公众号。'
          : '还没登录：设置 → 扫码登录。',
      );
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
  }

  private item(r: RowItem): HTMLElement {
    if (this.layout === 'feed') return this.feedItem(r);
    if (this.layout === 'official') return this.officialRow(r);
    if (this.layout === 'compact') return this.compactRow(r);
    return this.card(r);
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

  private card(r: RowItem): HTMLElement {
    const card = createEl('div', { cls: 'wmc-card' });
    if (r.read) card.addClass('is-read');
    const cover = card.createDiv('wmc-card-cover');
    if (r.picUrl) {
      const img = cover.createEl('img');
      img.src = r.picUrl;
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
    const el = createEl('div', { cls: `wmc-feed-item${r.picUrl ? ' has-img' : ''}${r.read ? ' is-read' : ''}` });
    if (r.picUrl) {
      const img = el.createEl('img', { cls: 'wmc-feed-img' });
      img.src = r.picUrl;
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
    if (r.picUrl) {
      const img = thumb.createEl('img');
      img.src = r.picUrl;
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
