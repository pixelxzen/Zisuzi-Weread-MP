import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';

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

type Filter = { account: string; unreadOnly: boolean; query: string };

function fmtDay(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class WmcView extends ItemView {
  private plugin: WereadMpCatcher;
  private filter: Filter = { account: '', unreadOnly: false, query: '' };
  private selectedId = '';
  private listEl: HTMLElement | null = null;
  private readerEl: HTMLElement | null = null;
  private width = 300;
  private searching = false;

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
    this.width = this.plugin.settings.listWidth || 300;
    this.renderShell();
    this.renderList();
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onKey(ev));
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /* --------------------------------- shell -------------------------------- */

  private renderShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('wmc-root');

    const bar = root.createDiv('wmc-toolbar');
    this.iconBtn(bar, 'panel-left-close', '收起列表', () => this.toggleList());
    this.buildChannelPicker(bar);

    const spacer = bar.createDiv('wmc-spacer');
    spacer.style.flex = '1';

    this.iconBtn(bar, 'search', '搜索', () => this.toggleSearch());
    this.iconBtn(bar, 'refresh-cw', '抓取一轮', () => void this.plugin.runOnce(true).then(() => this.renderList()));
    this.iconBtn(bar, 'circle', '只看未读', () => {
      this.filter.unreadOnly = !this.filter.unreadOnly;
      this.renderList();
    });
    this.iconBtn(bar, 'play', '开始 / 停止盯采', () => {
      this.plugin.toggleWatchFromView();
      this.renderToolbarState();
    });

    const body = root.createDiv('wmc-body');
    const listWrap = body.createDiv('wmc-listwrap');
    listWrap.style.width = `${this.width}px`;
    this.listEl = listWrap.createDiv('wmc-list');

    const resizer = body.createDiv('wmc-resizer');
    resizer.addEventListener('mousedown', (ev) => this.startResize(ev, listWrap));

    this.readerEl = body.createDiv('wmc-reader');
    this.readerEl.createDiv('wmc-hint').setText('从左侧选择一篇文章');

    this.renderToolbarState();
  }

  private iconBtn(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: 'wmc-icon-btn' });
    setIcon(b, icon);
    // 用 visually-hidden 文本而不是 title/aria-label，避免 Obsidian 映射成 hover 气泡
    const sr = b.createSpan('wmc-sr');
    sr.setText(label);
    b.addEventListener('click', onClick);
    return b;
  }

  private renderToolbarState(): void {
    const playBtn = this.contentEl.querySelector('.wmc-toolbar button:nth-last-child(1)');
    if (playBtn) {
      playBtn.empty();
      setIcon(playBtn as HTMLElement, this.plugin.isWatching() ? 'pause' : 'play');
      const sr = (playBtn as HTMLElement).createSpan('wmc-sr');
      sr.setText(this.plugin.isWatching() ? '停止盯采' : '开始盯采');
    }
  }

  private toggleSearch(): void {
    this.searching = !this.searching;
    const bar = this.contentEl.querySelector('.wmc-toolbar');
    const exist = this.contentEl.querySelector('.wmc-search');
    if (this.searching && bar && !exist) {
      const input = createEl('input', { cls: 'wmc-search', type: 'search', placeholder: '搜索标题 / 公众号' });
      bar.prepend(input);
      input.focus();
      input.addEventListener('input', () => {
        this.filter.query = input.value.trim();
        this.renderList();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          this.filter.query = '';
          input.remove();
          this.searching = false;
          this.renderList();
        }
      });
    } else if (exist) {
      exist.remove();
      this.filter.query = '';
      this.searching = false;
      this.renderList();
    }
  }

  private buildChannelPicker(bar: HTMLElement): void {
    const btn = bar.createEl('button', { cls: 'wmc-channel' });
    btn.setText(this.filter.account || '全部公众号');
    btn.addEventListener('click', () => this.openChannelMenu(btn));
  }

  private openChannelMenu(anchor: HTMLElement): void {
    const accounts = this.plugin.accountNames();
    const existing = document.querySelector('.wmc-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const menu = document.body.createDiv('wmc-menu');
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.zIndex = '9999';

    const mkItem = (label: string, value: string) => {
      const it = menu.createDiv('wmc-menu-item');
      it.setText(label);
      if (value === this.filter.account) it.addClass('is-active');
      it.addEventListener('click', () => {
        this.filter.account = value;
        menu.remove();
        this.renderShell();
        this.renderList();
      });
    };
    mkItem('全部公众号', '');
    for (const a of accounts) mkItem(a, a);

    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }

  private toggleList(): void {
    const wrap = this.contentEl.querySelector('.wmc-listwrap') as HTMLElement | null;
    const resizer = this.contentEl.querySelector('.wmc-resizer') as HTMLElement | null;
    if (!wrap) return;
    const hidden = wrap.hasClass('is-hidden');
    wrap.toggleClass('is-hidden', !hidden);
    resizer?.toggleClass('is-hidden', !hidden);
  }

  private startResize(ev: MouseEvent, wrap: HTMLElement): void {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = wrap.offsetWidth;
    const onMove = (e: MouseEvent) => {
      const w = Math.min(520, Math.max(220, startW + (e.clientX - startX)));
      wrap.style.width = `${w}px`;
      this.width = w;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.plugin.settings.listWidth = this.width;
      void this.plugin.saveAll();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* --------------------------------- data --------------------------------- */

  private rows(): RowItem[] {
    const p = this.plugin;
    const discovered = p.state.discovered || {};
    const processed = p.state.processed || {};
    const readMap = p.state.read || {};
    const out: RowItem[] = [];

    for (const [rid, d] of Object.entries(discovered)) {
      const done = processed[rid];
      if (this.filter.account && d.account !== this.filter.account) continue;
      const read = !!readMap[rid];
      if (this.filter.unreadOnly && read) continue;
      if (this.filter.query) {
        const q = this.filter.query.toLowerCase();
        if (!d.title.toLowerCase().includes(q) && !d.account.toLowerCase().includes(q)) continue;
      }
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
    }
    // 已归档但不在 discovered 里的（历史数据）也补上
    for (const [rid, v] of Object.entries(processed)) {
      if (discovered[rid]) continue;
      if (this.filter.account && v.account !== this.filter.account) continue;
      const read = !!readMap[rid];
      if (this.filter.unreadOnly && read) continue;
      if (this.filter.query) {
        const q = this.filter.query.toLowerCase();
        if (!v.title.toLowerCase().includes(q) && !v.account.toLowerCase().includes(q)) continue;
      }
      out.push({
        reviewId: rid,
        title: v.title,
        account: v.account,
        time: v.time,
        archived: true,
        path: v.path,
        read,
      });
    }

    out.sort((a, b) => b.time - a.time);
    return out;
  }

  /* -------------------------------- render -------------------------------- */

  renderList(): void {
    if (!this.listEl) return;
    const el = this.listEl;
    el.empty();

    const rows = this.rows();
    const unread = rows.filter((r) => !r.read).length;
    const head = el.createDiv('wmc-list-head');
    head.setText(`${rows.length} 篇${unread ? ` · ${unread} 未读` : ''}`);

    if (!rows.length) {
      const empty = el.createDiv('wmc-empty');
      empty.setText(
        this.plugin.settings.cookie
          ? '还没有文章。点顶部刷新抓取一轮，或检查账号设置。'
          : '还没登录：在设置里填 Cookie 或扫码登录。',
      );
      return;
    }

    // 分片渲染，避免一次性插入上千行
    let i = 0;
    const chunk = 80;
    const draw = () => {
      const frag = document.createDocumentFragment();
      const end = Math.min(rows.length, i + chunk);
      for (; i < end; i++) frag.appendChild(this.renderRow(rows[i]));
      el.appendChild(frag);
      if (i < rows.length) window.setTimeout(draw, 0);
    };
    draw();
  }

  private renderRow(r: RowItem): HTMLElement {
    const row = createEl('div', { cls: 'wmc-row' });
    if (r.reviewId === this.selectedId) row.addClass('is-selected');
    if (r.read) row.addClass('is-read');

    const dot = row.createDiv('wmc-dot');
    setIcon(dot, r.read ? 'circle-check' : 'circle');

    const main = row.createDiv('wmc-row-main');
    const meta = main.createDiv('wmc-row-meta');
    meta.createSpan({ text: r.account });
    meta.createSpan({ cls: 'wmc-row-date', text: fmtDay(r.time) });

    main.createDiv({ cls: 'wmc-row-title', text: r.title });

    if (r.readNum !== undefined) {
      const sub = main.createDiv('wmc-row-sub');
      sub.setText(`阅读 ${r.readNum}${r.likeNum !== undefined ? ` · 赞 ${r.likeNum}` : ''}`);
    }

    if (r.picUrl) {
      const img = row.createEl('img', { cls: 'wmc-thumb' });
      img.src = r.picUrl;
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
    }

    row.addEventListener('click', () => void this.select(r));
    return row;
  }

  private async select(r: RowItem): Promise<void> {
    this.selectedId = r.reviewId;
    this.plugin.markRead(r.reviewId);
    this.renderList();
    await this.showArticle(r);
  }

  private async showArticle(r: RowItem): Promise<void> {
    const reader = this.readerEl;
    if (!reader) return;
    reader.empty();

    const head = reader.createDiv('wmc-reader-head');
    head.createDiv({ cls: 'wmc-reader-title', text: r.title });
    const meta = head.createDiv('wmc-reader-meta');
    meta.setText(`${r.account}${r.readNum !== undefined ? ` · 阅读 ${r.readNum}` : ''}`);

    const actions = head.createDiv('wmc-reader-actions');
    if (r.archived && r.path) {
      const openBtn = actions.createEl('button', { cls: 'wmc-text-btn', text: '在笔记中打开' });
      openBtn.addEventListener('click', () => {
        const f = this.app.vault.getAbstractFileByPath(r.path!);
        if (f) void this.app.workspace.openLinkText(r.path!, '', false);
        else new Notice('笔记文件不存在');
      });
      const aiBtn = actions.createEl('button', { cls: 'wmc-text-btn', text: 'AI 总结' });
      aiBtn.addEventListener('click', () => void this.aiSummarize(r));
    } else {
      const grabBtn = actions.createEl('button', { cls: 'wmc-text-btn is-primary', text: '抓取并归档' });
      grabBtn.addEventListener('click', async () => {
        grabBtn.disabled = true;
        grabBtn.setText('抓取中…');
        const ok = await this.plugin.archiveSingle(r.reviewId, r.account);
        grabBtn.disabled = false;
        if (ok) {
          const fresh = this.rows().find((x) => x.reviewId === r.reviewId);
          if (fresh) await this.select(fresh);
        } else {
          grabBtn.setText('抓取失败，重试');
        }
      });
    }

    const bodyEl = reader.createDiv('wmc-reader-body');
    if (r.archived && r.path) {
      const f = this.app.vault.getAbstractFileByPath(r.path);
      if (f) {
        const md = await this.app.vault.cachedRead(f as any);
        bodyEl.addClass('markdown-rendered');
        await MarkdownRenderer.render(this.app, md, bodyEl, r.path, this);
        return;
      }
    }
    bodyEl.createDiv('wmc-hint').setText('这篇文章还没归档。点「抓取并归档」把它存进笔记。');
  }

  private async aiSummarize(r: RowItem): Promise<void> {
    const notes = r.path ? await this.plugin.readNoteBody(r.path) : '';
    if (!notes) {
      new Notice('先归档这篇，再让它总结');
      return;
    }
    const t = new Notice('AI 总结中…', 0);
    try {
      const done = await this.plugin.aiSummarizeNote(r.path!, r.title, notes);
      t.hide();
      new Notice(done ? '摘要已写入笔记末尾「## AI 摘要」' : '摘要失败，看控制台');
      this.renderList();
    } catch (e) {
      t.hide();
      new Notice(`AI 失败：${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  /* -------------------------------- keyboard ------------------------------- */

  private onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const rows = this.rows();
    if (!rows.length) return;
    const idx = rows.findIndex((r) => r.reviewId === this.selectedId);
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const next = rows[Math.min(rows.length - 1, idx < 0 ? 0 : idx + 1)];
      if (next) void this.select(next);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = rows[Math.max(0, idx <= 0 ? 0 : idx - 1)];
      if (prev) void this.select(prev);
    } else if (ev.key === '/') {
      ev.preventDefault();
      if (!this.searching) this.toggleSearch();
    }
  }
}
