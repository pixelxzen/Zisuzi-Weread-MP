import { App, Modal, Notice, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
import type { AccountRef } from '../main';
import type { BfItem, BfState, BfProgress } from '../core/bf';

/**
 * 单号全量归档（v3.3）
 *
 * 布局范式：左标签 + 右控件的对齐网格（Linear / Vercel 设置面板做法），
 * 不用 Obsidian 的 Setting 表单行。
 * 所有原生控件（select / input / button / date）都剥离默认外观重绘，
 * 否则 Obsidian 主题样式会把它压成「像纯文本」的样子。
 */
const ICON: Record<BfState, string> = {
  pending: 'circle',
  running: 'loader',
  done: 'check',
  failed: 'alert-triangle',
  skipped: 'minus',
};

const STATE_LABEL: Record<BfState, string> = {
  pending: '待抓',
  running: '抓取中',
  done: '已归档',
  failed: '失败',
  skipped: '已存在',
};

export class BackfillModal extends Modal {
  private plugin: WereadMpCatcher;
  private accounts: AccountRef[];
  private picked: string;
  private maxItems = 30;
  private fromDate = '';
  private speed: 'safe' | 'slow' = 'safe';
  private signal = { stop: false };
  private running = false;

  private progEl: HTMLElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private listEl: HTMLElement | null = null;
  private startedAt = 0;
  private items: BfItem[] = [];

  constructor(app: App, plugin: WereadMpCatcher, preset?: string) {
    super(app);
    this.plugin = plugin;
    this.accounts = plugin.settings.accounts;
    this.picked = preset || this.accounts[0]?.name || '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('wmc-bf');
    // 宽度控制在 .modal 上（contentEl 只有 padding，改它会被内容撑破）
    this.modalEl.addClass('wmc-bf-modal');
    this.modalEl.style.width = 'min(600px, 92vw)';

    /* ---------------------------------- 头部 --------------------------------- */
    const head = contentEl.createDiv('wmc-bf-head');
    const mark = head.createDiv('wmc-bf-mark');
    setIcon(mark, 'archive');
    const ht = head.createDiv('wmc-bf-head-txt');
    ht.createDiv({ cls: 'wmc-bf-h1', text: '归档全部历史' });
    ht.createDiv({ cls: 'wmc-bf-h2', text: '把一个号的历史文章抓进知识库' });
    this.modalEl.addClass('has-close');

    /* ---------------------------- 组 1：抓取范围 ---------------------------- */
    const g1 = contentEl.createDiv('wmc-bf-group');
    g1.createDiv({ cls: 'wmc-bf-sec', text: '抓取范围' });
    const f1 = g1.createDiv('wmc-bf-form');

    const row = (parent: HTMLElement, label: string): HTMLElement => {
      parent.createDiv({ cls: 'wmc-bf-key', text: label });
      return parent.createDiv('wmc-bf-val');
    };
    const addHint = (val: HTMLElement, text: string) => val.createDiv({ cls: 'wmc-bf-hint', text });

    // 公众号 —— select 自绘箭头
    const accVal = row(f1, '公众号');
    const selWrap = accVal.createDiv('wmc-bf-select-wrap');
    const sel = selWrap.createEl('select', { cls: 'wmc-bf-select' });
    for (const a of this.accounts) sel.createEl('option', { value: a.name, text: a.name });
    if (this.picked) sel.value = this.picked;
    const chev = selWrap.createSpan({ cls: 'wmc-bf-chev' });
    setIcon(chev, 'chevron-down');
    sel.addEventListener('change', () => {
      this.picked = sel.value;
      this.items = [];
      this.renderProgIdle();
      this.listEl?.empty();
    });

    // 起始日期（文本输入，避免原生三段 spinner）
    const dateVal = row(f1, '从哪天起');
    const dInput = dateVal.createEl('input', {
      cls: 'wmc-bf-input is-date',
      type: 'text',
      attr: { placeholder: 'YYYY-MM-DD，可留空' },
    });
    dInput.addEventListener('change', () => {
      const v = dInput.value.trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        new Notice('日期格式要写成 2026-01-01 这样');
        dInput.value = '';
        this.fromDate = '';
        return;
      }
      this.fromDate = v;
    });
    addHint(dateVal, '留空 = 从最新往回抓');

    /* ---------------------------- 组 2：抓取节奏 ---------------------------- */
    const g2 = contentEl.createDiv('wmc-bf-group');
    g2.createDiv({ cls: 'wmc-bf-sec', text: '抓取节奏' });
    const f2 = g2.createDiv('wmc-bf-form');

    const batchVal = row(f2, '单批上限');
    const batchLine = batchVal.createDiv('wmc-bf-inline');
    const bInput = batchLine.createEl('input', { cls: 'wmc-bf-input is-num', type: 'number' });
    bInput.value = String(this.maxItems);
    bInput.min = '1';
    bInput.max = '500';
    batchLine.createSpan({ cls: 'wmc-bf-unit', text: '篇' });
    bInput.addEventListener('input', () => {
      const n = Number(bInput.value);
      if (Number.isFinite(n) && n > 0) this.maxItems = Math.min(500, Math.round(n));
    });
    addHint(batchVal, '建议 ≤30 篇，跑完隔 10 分钟再下一批');

    const spdVal = row(f2, '速度');
    const seg = spdVal.createDiv('wmc-bf-seg');
    const mkSeg = (v: 'safe' | 'slow', label: string, sub: string) => {
      const b = seg.createEl('button', { cls: `wmc-bf-seg-btn${this.speed === v ? ' is-on' : ''}` });
      b.createSpan({ cls: 'wmc-bf-seg-t', text: label });
      b.createSpan({ cls: 'wmc-bf-seg-s', text: sub });
      b.addEventListener('click', () => {
        this.speed = v;
        seg
          .querySelectorAll('.wmc-bf-seg-btn')
          .forEach((el, i) => el.toggleClass('is-on', i === (v === 'safe' ? 0 : 1)));
      });
    };
    mkSeg('safe', '安全（默认）', '1.2s / 2.5s / 15 休 60s');
    mkSeg('slow', '极保守', '3s / 6s / 10 休 120s');
    addHint(spdVal, '越保守越不容易被风控，也越慢');

    /* ---------------------------- 组 3：风控说明 ---------------------------- */
    const g3 = contentEl.createDiv('wmc-bf-group');
    const warn = g3.createDiv('wmc-bf-warn');
    const wi = warn.createSpan('wmc-bf-warn-ico');
    setIcon(wi, 'shield-alert');
    warn.createSpan({
      text: '命中风控码会立即停止且不重试。被拦后等几小时（严重时一天）再继续。',
    });

    /* ------------------------------ 组 4：进度 ------------------------------ */
    const g4 = contentEl.createDiv('wmc-bf-group');
    g4.createDiv({ cls: 'wmc-bf-sec', text: '进度' });
    this.progEl = g4.createDiv('wmc-bf-prog');
    this.renderProgIdle();

    /* ---------------------------- 组 5：文章明细 ---------------------------- */
    const g5 = contentEl.createDiv('wmc-bf-group');
    g5.createDiv({ cls: 'wmc-bf-sec', text: '文章明细' });
    this.listEl = g5.createDiv('wmc-bf-list');
    this.renderItems();

    /* ---------------------------------- 底部 --------------------------------- */
    const foot = contentEl.createDiv('wmc-bf-foot');
    const stop = foot.createEl('button', { cls: 'wmc-bf-btn', text: '停止' });
    stop.disabled = true;
    this.stopBtn = stop;
    stop.addEventListener('click', () => {
      this.signal.stop = true;
      new Notice('已请求停止（当前这篇抓完后停）');
    });
    const start = foot.createEl('button', { cls: 'wmc-bf-btn is-primary', text: '开始归档' });
    start.addEventListener('click', () => void this.start());
  }

  private renderProgIdle(): void {
    const el = this.progEl;
    if (!el) return;
    el.empty();
    const top = el.createDiv('wmc-bf-prog-top');
    top.createDiv({ cls: 'wmc-bf-pct', text: '0%' });
    const meta = top.createDiv('wmc-bf-prog-meta');
    meta.createDiv({ cls: 'wmc-bf-prog-main', text: '等待开始' });
    const bar = el.createDiv('wmc-bf-bar');
    const f = bar.createDiv('wmc-bf-bar-fill');
    f.style.width = '0%';
  }

  private async start(only?: string[]): Promise<void> {
    if (this.running) return;
    const acc = this.accounts.find((a) => a.name === this.picked);
    if (!acc) {
      new Notice('请先选择公众号');
      return;
    }
    this.running = true;
    this.signal.stop = false;
    if (this.stopBtn) this.stopBtn.disabled = false;
    this.startedAt = Date.now();
    this.items = [];
    this.listEl?.empty();
    this.progEl?.empty();

    const res = await this.plugin.runBackfill(
      acc,
      { maxItems: this.maxItems, fromDate: this.fromDate, speed: this.speed, only },
      (p) => this.renderProgress(p),
      this.signal,
    );

    this.running = false;
    if (this.stopBtn) this.stopBtn.disabled = true;
    this.items = res.items;
    this.renderProgress({
      phase: 'fetch',
      done: res.items.length,
      total: res.items.length,
      written: res.written,
      items: res.items,
    });
    this.appendFootNote(
      res.error
        ? `⛔ ${res.error}`
        : `完成 · 归档 ${res.written} · 已存在 ${res.skipped} · 失败 ${res.failed}${
            res.stopped ? '（手动停止）' : ''
          }${res.written >= this.maxItems ? '　已达单批上限，隔 10 分钟再跑' : ''}`,
      !!res.error,
    );
    if (res.error) new Notice(res.error, 12000);

    if (res.failed > 0) {
      const foot = this.contentEl.querySelector('.wmc-bf-foot') as HTMLElement | null;
      if (foot && !foot.querySelector('.wmc-bf-retry')) {
        const b = foot.createEl('button', {
          cls: 'wmc-bf-btn is-warn wmc-bf-retry',
          text: `重试 ${res.failed} 篇`,
        });
        b.addEventListener('click', () => {
          b.remove();
          void this.start(res.items.filter((i) => i.state === 'failed').map((i) => i.reviewId));
        });
      }
    }
  }

  private appendFootNote(text: string, bad: boolean): void {
    const el = this.progEl;
    if (!el) return;
    el.createDiv({ cls: `wmc-bf-note${bad ? ' is-bad' : ''}`, text });
  }

  private renderProgress(p: BfProgress): void {
    const el = this.progEl;
    if (!el) return;
    el.empty();

    if (p.phase === 'list') {
      const top = el.createDiv('wmc-bf-prog-top');
      top.createDiv({ cls: 'wmc-bf-pct', text: '···' });
      const meta = top.createDiv('wmc-bf-prog-meta');
      meta.createDiv({ cls: 'wmc-bf-prog-main', text: p.detail ?? '翻列表中' });
      const bar = el.createDiv('wmc-bf-bar');
      bar.createDiv('wmc-bf-bar-fill is-indet');
      return;
    }

    const done = p.items.filter((i) => i.state === 'done').length;
    const failed = p.items.filter((i) => i.state === 'failed').length;
    const skipped = p.items.filter((i) => i.state === 'skipped').length;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;

    const top = el.createDiv('wmc-bf-prog-top');
    top.createDiv({ cls: 'wmc-bf-pct', text: `${pct}%` });
    const meta = top.createDiv('wmc-bf-prog-meta');
    meta.createDiv({ cls: 'wmc-bf-prog-main', text: `${p.done} / ${p.total}` });
    if (p.done > 0 && p.done < p.total && this.startedAt) {
      const per = (Date.now() - this.startedAt) / p.done;
      const left = Math.max(0, Math.round((per * (p.total - p.done)) / 1000));
      meta.createDiv({
        cls: 'wmc-bf-prog-eta',
        text: left > 90 ? `还需 ${Math.round(left / 60)} 分钟` : `还需 ${left} 秒`,
      });
    }

    const bar = el.createDiv('wmc-bf-bar');
    const fill = bar.createDiv('wmc-bf-bar-fill');
    fill.style.width = `${Math.min(100, pct)}%`;
    if (failed) fill.addClass('is-bad');

    const chips = el.createDiv('wmc-bf-chips');
    const chip = (cls: string, icon: string, text: string) => {
      const c = chips.createDiv(`wmc-bf-chip ${cls}`);
      const i = c.createSpan({ cls: 'wmc-bf-chip-ico' });
      setIcon(i, icon);
      c.createSpan({ text });
    };
    chip('is-ok', 'check', `已归档 ${done}`);
    if (skipped) chip('is-skip', 'minus', `已存在 ${skipped}`);
    if (failed) chip('is-bad', 'alert-triangle', `失败 ${failed}`);

    this.renderItems();
  }

  private renderItems(): void {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    if (!this.items.length) {
      el.createDiv({ cls: 'wmc-bf-list-empty', text: '点「开始归档」后，这里会逐篇显示每篇的状态' });
      return;
    }
    for (const it of this.items) {
      const row = el.createDiv(`wmc-bf-row is-${it.state}`);
      const ico = row.createSpan({ cls: 'wmc-bf-ico' + (it.state === 'running' ? ' is-spin' : '') });
      setIcon(ico, ICON[it.state] ?? 'circle');
      row.createSpan({ cls: 'wmc-bf-name', text: it.title || '(无标题)' });
      if (it.ms) row.createSpan({ cls: 'wmc-bf-time', text: `${(it.ms / 1000).toFixed(1)}s` });
      const tag = row.createSpan({ cls: `wmc-bf-tag is-${it.state}` });
      tag.setText(it.note || STATE_LABEL[it.state]);
    }
    const running = el.querySelector('.wmc-bf-row.is-running') as HTMLElement | null;
    if (running) running.scrollIntoView({ block: 'nearest' });
  }

  onClose(): void {
    this.signal.stop = true;
    this.contentEl.empty();
  }
}
