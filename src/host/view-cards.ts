import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon,
  TFile,
} from 'obsidian';
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
}

type Mode = 'list' | 'detail' | 'stats';
type Tab = 'body' | 'ai' | 'origin';

function fmtDay(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class WmcView extends ItemView {
  private plugin: WereadMpCatcher;
  private mode: Mode = 'list';
  private account = '';
  private unreadOnly = false;
  private query = '';
  private selected: RowItem | null = null;
  private tab: Tab = 'body';

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
    this.render();
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onKey(ev));
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /* ------------------------------- 数据 ------------------------------- */

  private rows(): RowItem[] {
    const p = this.plugin;
    const discovered = p.state.discovered || {};
    const processed = p.state.processed || {};
    const readMap = p.state.read || {};
    const out: RowItem[] = [];
    const push = (
      rid: string,
      d: { account: string; title: string; time: number; readNum?: number; likeNum?: number; picUrl?: string },
    ) => {
      if (this.account && d.account !== this.account) return;
      const read = !!readMap[rid];
      if (this.unreadOnly && read) return;
      if (this.query) {
        const q = this.query.toLowerCase();
        if (!d.title.toLowerCase().includes(q) && !d.account.toLowerCase().includes(q)) return;
      }
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
        read,
      });
    };
    for (const [rid, d] of Object.entries(discovered)) push(rid, d);
    for (const [rid, v] of Object.entries(processed)) {
      if (!discovered[rid]) push(rid, { account: v.account, title: v.title, time: v.time });
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }

  /* ------------------------------- 渲染 ------------------------------- */

  render(): void {
    const root = this.contentEl;
    root.empty();
    if (this.mode === 'list') this.renderList();
    else if (this.mode === 'detail') void this.renderDetail();
    else this.renderStats();
  }

  private toolbar(parent: HTMLElement): void {
    const bar = parent.createDiv('wmc-toolbar');
    if (this.mode !== 'list') {
      this.iconBtn(bar, 'arrow-left', '返回列表', () => {
        this.mode = 'list';
        this.selected = null;
        this.render();
      });
    }
    const ch = bar.createEl('button', { cls: 'wmc-channel', text: this.account || '全部公众号' });
    ch.addEventListener('click', () => this.openChannelMenu(ch));
    bar.createDiv('wmc-spacer').setCssStyles({ flex: '1' });
    this.iconBtn(bar, 'search', '搜索', () => this.toggleSearch(bar));
    this.iconBtn(bar, 'circle', '只看未读', () => {
      this.unreadOnly = !this.unreadOnly;
      this.render();
    });
    this.iconBtn(bar, 'refresh-cw', '抓取一轮', () => void this.plugin.runOnce(true).then(() => this.render()));
    this.iconBtn(bar, this.plugin.isWatching() ? 'pause' : 'play', '开始/停止盯采', () => {
      this.plugin.toggleWatchFromView();
      this.render();
    });
    this.iconBtn(bar, 'archive', '归档某个号的全部历史', () =>
      new BackfillModal(this.app, this.plugin, this.account || undefined).open(),
    );
    this.iconBtn(bar, 'bar-chart-3', '盯采统计', () => {
      this.mode = this.mode === 'stats' ? 'list' : 'stats';
      this.render();
    });
  }

  private iconBtn(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const b = parent.createEl('button', { cls: 'wmc-icon-btn' });
    setIcon(b, icon);
    b.createSpan('wmc-sr').setText(label);
    b.addEventListener('click', onClick);
  }

  private toggleSearch(bar: HTMLElement): void {
    const exist = bar.querySelector<HTMLElement>('.wmc-search');
    if (exist) {
      exist.remove();
      this.query = '';
      this.render();
      return;
    }
    const input = bar.createEl('input', { cls: 'wmc-search', type: 'search', placeholder: '搜索标题 / 公众号' });
    bar.prepend(input);
    input.focus();
    input.addEventListener('input', () => {
      this.query = input.value.trim();
      if (this.mode === 'list') this.render();
    });
  }

  private openChannelMenu(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const menu = document.body.createDiv('wmc-menu');
    menu.setCssStyles({ position: 'fixed' });
    menu.setCssStyles({ left: `${rect.left}px` });
    menu.setCssStyles({ top: `${rect.bottom + 4}px` });
    menu.setCssStyles({ zIndex: '9999' });
    const mk = (label: string, value: string) => {
      const it = menu.createDiv('wmc-menu-item');
      it.setText(label);
      if (value === this.account) it.addClass('is-active');
      it.addEventListener('click', () => {
        this.account = value;
        menu.remove();
        this.mode = 'list';
        this.render();
      });
    };
    mk('全部公众号', '');
    for (const n of this.plugin.accountNames()) mk(n, n);
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }

  /* --------------------------- 列表：卡片网格 --------------------------- */

  private renderList(): void {
    const root = this.contentEl;
    this.toolbar(root);
    const rows = this.rows();
    const unread = rows.filter((r) => !r.read).length;
    root.createDiv('wmc-list-meta').setText(`${rows.length} 篇 · ${unread} 未读${this.account ? ` · ${this.account}` : ''}`);

    if (!rows.length) {
      root.createDiv('wmc-empty').setText(
        this.plugin.settings.cookie ? '还没有文章。点刷新抓一轮，或去设置勾选公众号。' : '还没登录：设置 → 扫码登录。',
      );
      return;
    }

    const grid = root.createDiv('wmc-grid');
    let i = 0;
    const step = () => {
      const frag = createFragment();
      for (const r of rows.slice(i, i + 60)) frag.appendChild(this.card(r));
      i += 60;
      grid.appendChild(frag);
      if (i < rows.length) window.setTimeout(step, 0);
    };
    step();
  }

  private card(r: RowItem): HTMLElement {
    const card = createDiv({ cls: 'wmc-card' });
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
    const foot = body.createDiv('wmc-card-foot');
    foot.createSpan({ cls: 'wmc-card-acc', text: r.account });
    foot.createSpan({ cls: 'wmc-card-date', text: fmtDay(r.time) });
    if (r.readNum !== undefined) {
      body.createDiv({
        cls: 'wmc-card-sub',
        text: `阅读 ${r.readNum}${r.likeNum !== undefined ? ` · 赞 ${r.likeNum}` : ''}`,
      });
    }
    card.addEventListener('click', () => {
      this.plugin.markRead(r.reviewId);
      this.selected = r;
      this.mode = 'detail';
      this.tab = 'body';
      this.render();
    });
    return card;
  }

  /* ----------------------------- 详情 Tab ----------------------------- */

  private async renderDetail(): Promise<void> {
    const root = this.contentEl;
    const r = this.selected;
    this.toolbar(root);
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
      } · ${fmtDay(r.time)}`,
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
        text: '在微信读书打开原文',
        href: `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(r.reviewId)}`,
      });
      a.setAttr('target', '_blank');
      body.createDiv({ cls: 'wmc-hint', text: '需已登录微信读书网页版。' });
      return;
    }

    if (this.tab === 'ai') {
      if (!r.archived || !r.path) {
        body.createDiv({ cls: 'wmc-hint', text: '先归档这篇，再生成摘要。' });
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
        body.createDiv({ cls: 'wmc-hint', text: '还没有摘要。' });
        const btn = body.createEl('button', { cls: 'wmc-text-btn is-primary', text: '生成 AI 摘要' });
        btn.addEventListener('click', () => void this.doAi(r));
      }
      return;
    }

    if (r.archived && r.path) {
      const f = this.app.vault.getAbstractFileByPath(r.path);
      if (f instanceof TFile) {
        const md = await this.app.vault.cachedRead(f);
        body.addClass('markdown-rendered');
        await MarkdownRenderer.render(this.app, md, body, r.path, this);
        return;
      }
    }
    body.createDiv('wmc-hint').setText('这篇还没归档。');
    const btn = body.createEl('button', { cls: 'wmc-text-btn is-primary', text: '抓取并归档' });
    btn.addEventListener('click', () => {
      void (async () => {
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
        })();
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
    this.toolbar(root);
    const rows = this.rows();
    const byAcc = new Map<string, number>();
    for (const r of rows) byAcc.set(r.account, (byAcc.get(r.account) || 0) + 1);
    const week = rows.filter((r) => r.time >= Date.now() / 1000 - 7 * 86400).length;
    const archived = rows.filter((r) => r.archived).length;

    const wrap = root.createDiv('wmc-stats');
    const cards = wrap.createDiv('wmc-stat-cards');
    const card = (label: string, value: string) => {
      const c = cards.createDiv('wmc-stat-card');
      c.createDiv({ cls: 'wmc-stat-value', text: value });
      c.createDiv({ cls: 'wmc-stat-label', text: label });
    };
    card('总篇数', String(rows.length));
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
      track.createDiv('wmc-stat-fill').setCssStyles({ width: `${Math.round((n / max) * 100)}%` });
      row.createSpan({ cls: 'wmc-stat-row-num', text: String(n) });
    }
    if (!top.length) list.createDiv({ cls: 'wmc-hint', text: '还没有数据，先抓一轮。' });
  }

  /* ------------------------------ 键盘 ------------------------------ */

  private onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
      const bar = this.contentEl.querySelector<HTMLElement>('.wmc-toolbar');
      if (bar) this.toggleSearch(bar);
    }
  }
}
