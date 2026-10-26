import { App, Modal, Notice, Setting } from 'obsidian';

/**
 * 「补全小绿书（贴原链接）」输入框。
 * 微信读书对图片消息只给封面+摘要，必须回原页抓 —— 这里只负责收一条 mp 链接。
 */
export class GreenBookModal extends Modal {
  private url = '';
  private onSubmit: (url: string) => void;

  constructor(app: App, onSubmit: (url: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '补全小绿书（贴原链接）' });
    contentEl.createEl('p', {
      text:
        '微信读书对「图片消息」只返回封面 + 摘要，抓不到正文。请先在微信里打开这篇，' +
        '右上角「…」→ 复制链接，把 https://mp.weixin.qq.com/s/... 粘到下面。',
    });

    new Setting(contentEl).setName('原文链接').addText((t) => {
      t.setPlaceholder('https://mp.weixin.qq.com/s/...');
      t.onChange((v) => (this.url = v.trim()));
      t.inputEl.style.width = '100%';
      window.setTimeout(() => t.inputEl.focus(), 50);
      t.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') this.submit();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('开始补全')
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private submit(): void {
    const u = this.url.trim();
    if (!/^https?:\/\/mp\.weixin\.qq\.com\/s[\/?]/i.test(u)) {
      new Notice('请贴 mp.weixin.qq.com/s/... 形式的链接', 6000);
      return;
    }
    this.close();
    this.onSubmit(u);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
