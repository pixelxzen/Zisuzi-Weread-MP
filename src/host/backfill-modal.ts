import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type WereadMpCatcher from '../main';
import type { AccountRef } from '../main';

/**
 * 单号全量历史归档
 * 风控参数与建议来自 weread-mp-monitor skill 的实测结论。
 */
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

    new Setting(contentEl)
      .setName('公众号')
      .addDropdown((d) => {
        for (const a of this.accounts) d.addOption(a.name, a.name);
        if (this.picked) d.setValue(this.picked);
        d.onChange((v) => (this.picked = v));
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
      .addButton((b) =>
        b
          .setButtonText('开始归档')
          .setCta()
          .onClick(() => void this.start()),
      )
      .addButton((b) =>
        b.setButtonText('停止').onClick(() => {
          this.signal.stop = true;
          new Notice('已请求停止（当前这篇抓完后停）');
        }),
      );
  }

  private async start(): Promise<void> {
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
    const fill = bar.createDiv('wmc-progress-fill');
    const label = box.createDiv('wmc-progress-label');
    label.setText('翻列表中…');

    const res = await this.plugin.runBackfill(
      acc,
      { maxItems: this.maxItems, fromDate: this.fromDate, speed: this.speed },
      (p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        fill.style.width = `${Math.min(100, pct)}%`;
        label.setText(
          p.phase === 'list'
            ? `翻列表：${p.title ?? ''}`
            : `已归档 ${p.written} / ${p.total} · ${(p.title ?? '').slice(0, 28)}`,
        );
      },
      this.signal,
    );

    this.running = false;
    fill.style.width = '100%';
    if (res.error) {
      label.setText(`已停止：${res.error}`);
      new Notice(res.error, 12000);
    } else {
      label.setText(
        `完成：归档 ${res.written} 篇，跳过 ${res.skipped}${res.stopped ? '（手动停止）' : ''}` +
          (res.written >= this.maxItems ? '｜已达单批上限，隔 10 分钟再跑下一批' : ''),
      );
    }
  }

  onClose(): void {
    this.signal.stop = true;
    this.contentEl.empty();
  }
}
