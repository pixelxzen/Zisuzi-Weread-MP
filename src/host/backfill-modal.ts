import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
import type { AccountRef } from '../main';
import type { BfItem, BfState } from '../core/bf';

/**
 * 单号全量历史归档
 * - 逐篇状态可见：待抓 / 抓取中 / 已归档 / 已归档(跳过) / 失败
 * - 网络抖动自动重试 1 次并在行内标出「重试 1/2」
 * - 风控码立即熔断，不做自动重试
 * 风控参数与建议来自 weread-mp-monitor skill 的实测结论。
 */
const ICON: Record<BfState, string> = {
  pending: 'circle',
  running: 'loader',
  done: 'check-circle-2',
  failed: 'alert-triangle',
  skipped: 'minus-circle',
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

  private bodyEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private sumEl: HTMLElement | null = null;
  private fillEl: HTMLElement | null = null;
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
    contentEl.addClass('wmc-backfill');
    contentEl.createEl('h3', { text: '归档某个号的全部历史' });

    new Setting(contentEl).setName('公众号').addDropdown((d) => {
      for (const a of this.accounts) d.addOption(a.name, a.name);
      if (this.picked) d.setValue(this.picked);
      d.onChange((v) => {
        this.picked = v;
        this.items = [];
        this.bodyEl?.empty();
      });
    });

    new Setting(contentEl)
      .setName('单批上限')
      .setDesc('建议 ≤30 篇/批；跑完一批隔 ≥10 分钟再来下一批')
      .addText((t) =>
        t.setValue(String(this.maxItems)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) this.maxItems = Math.min(500, Math.round(n));
        }),
      );

    new Setting(contentEl)
      .setName('起始日期')
      .setDesc('留空 = 从最新往回；填 2026-01-01 = 只归档该日期之后')
      .addText((t) => {
        t.setPlaceholder('YYYY-MM-DD');
        t.onChange((v) => (this.fromDate = v.trim()));
      });

    new Setting(contentEl)
      .setName('速度档')
      .setDesc('安全：列表 1.2s / 正文 2.5s / 每 15 篇休 60s ｜ 极保守：3s / 6s / 每 10 篇休 120s')
      .addDropdown((d) =>
        d
          .addOption('safe', '安全（默认）')
          .addOption('slow', '极保守')
          .setValue(this.speed)
          .onChange((v) => (this.speed = v as 'safe' | 'slow')),
      );

    contentEl.createDiv({
      cls: 'wmc-backfill-tip',
      text:
        '风控建议：命中 -2010/-2012/-2041 会立即停止且不重试；被拦后等几小时（严重时一天）再继续。' +
        '439 篇量级建议分 15 批、每批间隔 10 分钟、夜间跑（净抓约 2.5 小时）。',
    });

    this.bodyEl = contentEl.createDiv('wmc-backfill-body');

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('开始归档').setCta().onClick(() => void this.start()))
      .addButton((b) =>
        b.setButtonText('停止').onClick(() => {
          this.signal.stop = true;
          new Notice('已请求停止（当前这篇抓完后停）');
        }),
      );
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
    const box = this.bodyEl;
    if (!box) return;
    box.empty();

    const bar = box.createDiv('wmc-progress');
    this.fillEl = bar.createDiv('wmc-progress-fill');
    this.sumEl = box.createDiv('wmc-bf-sum');
    this.sumEl.setText(only ? '重新抓取失败项…' : '翻列表中…');
    this.listEl = box.createDiv('wmc-bf-list');

    const res = await this.plugin.runBackfill(
      acc,
      { maxItems: this.maxItems, fromDate: this.fromDate, speed: this.speed, only },
      (p) => {
        this.items = p.items;
        if (p.phase === 'list') {
          this.sumEl?.setText(`翻列表中 · ${p.detail ?? ''}`);
          if (this.fillEl) this.fillEl.style.width = '4%';
          return;
        }
        const done = p.items.filter((i) => i.state === 'done').length;
        const failed = p.items.filter((i) => i.state === 'failed').length;
        const skip = p.items.filter((i) => i.state === 'skipped').length;
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        if (this.fillEl) this.fillEl.style.width = `${Math.min(100, pct)}%`;
        this.sumEl?.setText(
          `进度 ${p.done}/${p.total} · ✅ 已归档 ${done}` +
            (skip ? ` · ⤼ 已存在 ${skip}` : '') +
            (failed ? ` · ⚠️ 失败 ${failed}` : ''),
        );
        this.renderItems();
      },
      this.signal,
    );

    this.running = false;
    if (this.fillEl) {
      this.fillEl.style.width = res.failed ? `${Math.round(((res.items.length - res.failed) / Math.max(1, res.items.length)) * 100)}%` : '100%';
      this.fillEl.toggleClass('is-error', !!res.error || res.failed > 0);
    }
    this.items = res.items;
    this.renderItems();

    if (res.error) {
      this.sumEl?.setText(`已停止：${res.error}`);
      new Notice(res.error, 12000);
    } else {
      this.sumEl?.setText(
        `完成：归档 ${res.written} · 已存在 ${res.skipped} · 失败 ${res.failed}${res.stopped ? '（手动停止）' : ''}` +
          (res.written >= this.maxItems ? '｜已达单批上限，隔 10 分钟再跑下一批' : ''),
      );
    }

    // 失败项可一键重试（只重跑失败的那些，不重新翻列表）
    if (res.failed > 0) {
      const retry = this.bodyEl?.createEl('button', {
        cls: 'wmc-hero-btn is-primary',
        text: `重试失败的 ${res.failed} 篇`,
      });
      retry?.addEventListener('click', () => {
        retry.remove();
        const ids = res.items.filter((i) => i.state === 'failed').map((i) => i.reviewId);
        void this.start(ids);
      });
    }
  }

  private renderItems(): void {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    if (!this.items.length) {
      el.createDiv({ cls: 'wmc-bf-empty', text: '还没有任务' });
      return;
    }
    for (const it of this.items) {
      const row = el.createDiv(`wmc-bf-row is-${it.state}`);
      const ico = row.createSpan({ cls: 'wmc-bf-ico' + (it.state === 'running' ? ' is-spin' : '') });
      setIcon(ico, ICON[it.state] ?? 'circle');
      row.createSpan({ cls: 'wmc-bf-title', text: it.title || '(无标题)' });
      if (it.ms) row.createSpan({ cls: 'wmc-bf-ms', text: `${(it.ms / 1000).toFixed(1)}s` });
      if (it.note) {
        row.createSpan({
          cls: `wmc-bf-note${it.state === 'failed' ? ' is-bad' : ''}`,
          text: it.note,
        });
      }
    }
    const running = el.querySelector('.wmc-bf-row.is-running') as HTMLElement | null;
    if (running) running.scrollIntoView({ block: 'nearest' });
  }

  onClose(): void {
    this.signal.stop = true;
    this.contentEl.empty();
  }
}
