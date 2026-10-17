import { App, Modal, Notice, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
import type { AccountRef } from '../main';
import type { BfItem, BfState, BfProgress } from '../core/bf';

/**
 * 单号全量归档（v3.2 重构：品牌化卡片 + 一屏看全）
 *
 * 设计原则：
 * - 配置 → 进度 → 逐篇状态，一屏看全，不靠滚动找信息
 * - 每篇都有状态与耗时；网速抖动重试在行内可见
 * - 风控码立即熔断，永不自动重试
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

    /* ---------------------------------- 头部 --------------------------------- */
    const head = contentEl.createDiv('wmc-bf-head');
    const mark = head.createDiv('wmc-bf-mark');
    setIcon(mark, 'archive');
    const ht = head.createDiv('wmc-bf-head-txt');
    ht.createDiv({ cls: 'wmc-bf-h1', text: '归档全部历史' });
    ht.createDiv({ cls: 'wmc-bf-h2', text: '把一个号的历史文章批量抓进知识库' });
    const x = head.createEl('button', { cls: 'wmc-bf-x' });
    setIcon(x, 'x');
    x.setAttr('aria-label', '关闭');
    x.addEventListener('click', () => this.close());

    /* ---------------------------------- 表单 --------------------------------- */
    const form = contentEl.createDiv('wmc-bf-form');

    const accRow = form.createDiv('wmc-bf-field');
    accRow.createDiv({ cls: 'wmc-bf-label', text: '公众号' });
    const sel = accRow.createDiv('wmc-bf-ctrl').createEl('select', { cls: 'wmc-bf-select' });
    for (const a of this.accounts) sel.createEl('option', { value: a.name, text: a.name });
    if (this.picked) sel.value = this.picked;
    sel.addEventListener('change', () => {
      this.picked = sel.value;
      this.items = [];
      this.renderProgIdle();
      this.listEl?.empty();
    });

    const two = form.createDiv('wmc-bf-two');

    const batch = two.createDiv('wmc-bf-field');
    batch.createDiv({ cls: 'wmc-bf-label', text: '单批上限' });
    const bInput = batch.createDiv('wmc-bf-ctrl').createEl('input', {
      cls: 'wmc-bf-input',
      type: 'number',
    });
    bInput.value = String(this.maxItems);
    bInput.min = '1';
    bInput.max = '500';
    bInput.addEventListener('input', () => {
      const n = Number(bInput.value);
      if (Number.isFinite(n) && n > 0) this.maxItems = Math.min(500, Math.round(n));
    });
    batch.createDiv({ cls: 'wmc-bf-hint', text: '≤30 篇/批，批间隔 ≥10 分钟' });

    const dateF = two.createDiv('wmc-bf-field');
    dateF.createDiv({ cls: 'wmc-bf-label', text: '起始日期' });
    const dInput = dateF.createDiv('wmc-bf-ctrl').createEl('input', {
      cls: 'wmc-bf-input',
      type: 'date',
    });
    dInput.addEventListener('change', () => (this.fromDate = dInput.value));
    dateF.createDiv({ cls: 'wmc-bf-hint', text: '留空 = 从最新往回抓' });

    const spd = form.createDiv('wmc-bf-field');
    spd.createDiv({ cls: 'wmc-bf-label', text: '速度' });
    const seg = spd.createDiv('wmc-bf-ctrl').createDiv('wmc-bf-seg');
    const mkSeg = (v: 'safe' | 'slow', label: string, sub: string) => {
      const b = seg.createEl('button', { cls: `wmc-bf-seg-btn${this.speed === v ? ' is-on' : ''}` });
      b.createDiv({ cls: 'wmc-bf-seg-t', text: label });
      b.createDiv({ cls: 'wmc-bf-seg-s', text: sub });
      b.addEventListener('click', () => {
        this.speed = v;
        seg
          .querySelectorAll('.wmc-bf-seg-btn')
          .forEach((el, i) => el.toggleClass('is-on', i === (v === 'safe' ? 0 : 1)));
      });
    };
    mkSeg('safe', '安全', '1.2s / 2.5s / 15 篇休 60s');
    mkSeg('slow', '极保守', '3s / 6s / 10 篇休 120s');

    contentEl.createDiv({
      cls: 'wmc-bf-warn',
      text: '命中风控码立即停止且不重试；被拦后等几小时（严重时一天）再继续。',
    });

    /* ---------------------------------- 进度 --------------------------------- */
    this.progEl = contentEl.createDiv('wmc-bf-prog');
    this.renderProgIdle();

    /* ---------------------------------- 列表 --------------------------------- */
    this.listEl = contentEl.createDiv('wmc-bf-list');

    /* ---------------------------------- 底部 --------------------------------- */
    const foot = contentEl.createDiv('wmc-bf-foot');
    const stop = foot.createEl('button', { cls: 'wmc-bf-btn', text: '停止' });
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
    el.createDiv({ cls: 'wmc-bf-prog-note', text: '点右下角「开始归档」启动。' });
    const bar = el.createDiv('wmc-bf-bar');
    const fill = bar.createDiv('wmc-bf-bar-fill');
    fill.style.width = '0%';
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
        : `完成：归档 ${res.written} · 已存在 ${res.skipped} · 失败 ${res.failed}${
            res.stopped ? '（手动停止）' : ''
          }${res.written >= this.maxItems ? '｜已达单批上限，隔 10 分钟再跑下一批' : ''}`,
      !!res.error,
    );
    if (res.error) new Notice(res.error, 12000);

    if (res.failed > 0) {
      const foot = this.contentEl.querySelector('.wmc-bf-foot') as HTMLElement | null;
      if (foot && !foot.querySelector('.wmc-bf-retry')) {
        const b = foot.createEl('button', {
          cls: 'wmc-bf-btn is-warn wmc-bf-retry',
          text: `重试失败 ${res.failed} 篇`,
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
    el.createDiv({ cls: `wmc-bf-prog-note${bad ? ' is-bad' : ''}`, text });
  }

  private renderProgress(p: BfProgress): void {
    const el = this.progEl;
    if (!el) return;
    el.empty();

    if (p.phase === 'list') {
      el.createDiv({ cls: 'wmc-bf-prog-note', text: `正在翻列表 · ${p.detail ?? ''}` });
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
    meta.createDiv({ cls: 'wmc-bf-prog-main', text: `${p.done} / ${p.total} 篇` });
    if (p.done > 0 && p.done < p.total && this.startedAt) {
      const per = (Date.now() - this.startedAt) / p.done;
      const left = Math.max(0, Math.round((per * (p.total - p.done)) / 1000));
      meta.createDiv({
        cls: 'wmc-bf-prog-eta',
        text: left > 90 ? `预计还需 ${Math.round(left / 60)} 分钟` : `预计还需 ${left} 秒`,
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
    chip('is-ok', 'check', String(done));
    if (skipped) chip('is-skip', 'minus', String(skipped));
    if (failed) chip('is-bad', 'alert-triangle', String(failed));

    this.renderItems();
  }

  private renderItems(): void {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    if (!this.items.length) {
      el.createDiv({ cls: 'wmc-bf-list-empty', text: '还没有任务' });
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
