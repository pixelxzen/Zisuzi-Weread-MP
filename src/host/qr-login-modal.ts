import { App, Modal, Notice, requestUrl } from 'obsidian';
import { checkCookie, describeCookieCheck, normalizeCookie } from '../core/weread';
import {
  arrayBufferToBase64,
  createNodeTransport,
  pollQrStatus,
  startQrLogin,
  warmUpSession,
  type QrStart,
  type QrTransport,
} from '../core/qrlogin';

export interface QrLoginOptions {
  /** 拿到并校验过 cookie 后回调（由插件负责落盘 + 刷新界面） */
  onSuccess: (cookie: string) => Promise<void> | void;
}

const POLL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * 扫码登录弹窗：微信二维码直接由官方接口出图，插件轮询扫码状态。
 * 不依赖 webview / iframe / electron.remote，因此不会再出现「扫了没反应」。
 */
export class QrLoginModal extends Modal {
  private readonly opts: QrLoginOptions;
  private transport: QrTransport | null = null;
  private timer: number | null = null;
  private stopped = false;
  private busy = false;
  private startedAt = 0;
  private uuid = '';
  private imageUrl = '';
  private imageFallbackTried = false;
  /** 用户已经扫过一次（进入「请在手机上确认」阶段），此时不能再按总时长掐断 */
  private sawScan = false;
  private imgEl: HTMLImageElement | null = null;
  private taEl: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  constructor(app: App, opts: QrLoginOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('扫码登录微信读书');
    contentEl.addClass('wmc-qr-modal');

    contentEl.createDiv({
      cls: 'wmc-qr-tip',
      text: '用微信读书 App 的「扫一扫」扫下方二维码（用微信扫也可以，会跳到微信读书确认页），然后在手机上点「确认登录」。插件会自己接收登录态，不需要复制 cookie。',
    });

    const qrBox = contentEl.createDiv({ cls: 'wmc-qr-box' });
    this.imgEl = qrBox.createEl('img', { cls: 'wmc-qr-img' });
    this.imgEl.alt = '微信读书登录二维码';
    this.imgEl.addEventListener('error', () => void this.loadQrImageFallback());

    this.statusEl = contentEl.createDiv({ cls: 'wmc-qr-status', text: '正在获取二维码…' });
    this.hintEl = contentEl.createDiv({ cls: 'wmc-qr-hint', text: '' });

    const actions = contentEl.createDiv({ cls: 'wmc-qr-actions' });
    const refresh = actions.createEl('button', { cls: 'wmc-hero-btn', text: '刷新二维码' });
    refresh.addEventListener('click', () => void this.restart());

    const close = actions.createEl('button', { text: '关闭' });
    close.addEventListener('click', () => this.close());

    // 兜底：扫码彻底不通时，仍可手工粘贴 cookie
    const adv = contentEl.createEl('details', { cls: 'wmc-adv' });
    adv.createEl('summary', { text: '扫码一直失败？改为手动粘贴 cookie' });
    const ta = adv.createEl('textarea', { cls: 'wmc-qr-cookie' });
    ta.placeholder = 'wr_vid=…; wr_skey=…; wr_rt=…; wr_gid=…';
    ta.rows = 3;
    this.taEl = ta;
    const save = adv.createEl('button', { text: '保存这份 cookie' });
    save.addEventListener('click', () => void this.saveManual(ta.value));

    void this.start();
  }

  onClose(): void {
    this.stopped = true;
    this.clearTimer();
    this.contentEl.empty();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(text: string, hint?: string): void {
    this.statusEl?.setText(text);
    if (hint !== undefined) this.hintEl?.setText(hint);
  }

  private async start(): Promise<void> {
    if (!this.transport) this.transport = createNodeTransport();
    if (!this.transport) {
      this.setStatus('当前环境不支持扫码登录', '请在桌面端 Obsidian 使用；或展开下方手动粘贴 cookie');
      return;
    }
    this.stopped = false;
    this.busy = false;
    this.clearTimer();
    this.setStatus('正在获取二维码…', '');
    try {
      const qr: QrStart = await startQrLogin(this.transport);
      if (this.stopped) return;
      this.uuid = qr.uuid;
      this.imageUrl = qr.imageUrl;
      this.imageFallbackTried = false;
      this.sawScan = false;
      this.startedAt = Date.now();
      if (this.imgEl) {
        this.imgEl.src = qr.imageUrl;
        this.imgEl.removeClass('is-hidden');
      }
      this.setStatus('等待扫码…', '二维码约 5 分钟有效；每轮最多等 55 秒无响应属正常');
      this.schedulePoll(600);
    } catch (e) {
      this.setStatus(`获取二维码失败：${String(e).slice(0, 120)}`, '可点「刷新二维码」重试，或用下方手动 cookie');
    }
  }

  private async restart(): Promise<void> {
    if (this.busy) return;
    this.busy = false;
    await this.start();
  }

  /** 远程二维码被 CSP 拦截时，改走 requestUrl 取字节再转 data URL */
  private async loadQrImageFallback(): Promise<void> {
    if (this.imageFallbackTried || !this.imageUrl || !this.imgEl) return;
    this.imageFallbackTried = true;
    try {
      const r = await requestUrl({ url: this.imageUrl, method: 'GET', throw: false });
      if (r.status !== 200) return;
      this.imgEl.src = `data:image/jpeg;base64,${arrayBufferToBase64(r.arrayBuffer)}`;
    } catch {
      /* 保持原图，用户还能用「刷新二维码」重试 */
    }
  }

  private schedulePoll(delay = POLL_MS): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = window.setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.busy || !this.transport) return;
    if (!this.sawScan && Date.now() - this.startedAt > MAX_WAIT_MS) {
      this.setStatus('等待超时，二维码可能已失效', '点「刷新二维码」换一张再扫');
      return;
    }
    try {
      const r = await pollQrStatus(this.transport, this.uuid);
      if (this.stopped) return;
      switch (r.status) {
        case 'waiting':
          // 服务端每轮长轮询会 hold 约 55 秒再返回 LOGIN_TIMEOUT，属正常等待，不要报错
          this.setStatus('等待扫码…', '二维码约 5 分钟有效；每轮最多等 55 秒无响应属正常');
          break;
        case 'scanned':
          this.sawScan = true;
          this.setStatus('已扫码，请在手机上点「确认登录」', '确认后自动完成，无需重复扫码');
          break;
        case 'confirmed':
          this.busy = true;
          this.setStatus('已确认，正在接收登录态…', '');
          await this.finish(r.cookie ?? '');
          return;
        case 'expired':
          this.setStatus('二维码已过期', '点「刷新二维码」重新获取');
          return;
        case 'need-otp':
          this.setStatus('需要短信验证码，插件内无法完成', '请改用「用 Chrome 登录（Windows 推荐）」');
          return;
        default:
          this.setStatus('扫码状态未知，继续等待…', r.raw.slice(0, 80));
          break;
      }
    } catch {
      this.setStatus('轮询超时，继续等待…', '');
    }
    this.schedulePoll();
  }

  private async finish(rawCookie: string): Promise<void> {
    const t = this.transport;
    if (!t || !rawCookie) {
      this.busy = false;
      this.setStatus('服务端没有下发登录态', '点「刷新二维码」重试');
      return;
    }
    try {
      let cookie = normalizeCookie(rawCookie);
      let chk = checkCookie(cookie);
      if (!chk.ok) {
        // 缺 wr_gid / wr_skey 时，打一次轻量接口把会话级 cookie 补齐
        cookie = normalizeCookie(await warmUpSession(t, cookie));
        chk = checkCookie(cookie);
      }
      if (!chk.ok) {
        this.busy = false;
        // 保留这次已经拿到的部分 cookie，用户不必重扫：展开下方点一次「保存这份 cookie」
        // 就会再走一遍自动补全（wr_gid 由首页下发）。
        if (this.taEl) this.taEl.value = cookie;
        this.setStatus(
          `登录信息不完整：${describeCookieCheck(chk)}`,
          '已保留本次拿到的那部分，展开下方点「保存这份 cookie」可自动补全',
        );
        return;
      }
      this.setStatus('登录成功，正在同步书架…', '');
      this.stopped = true;
      this.clearTimer();
      await this.opts.onSuccess(cookie);
      this.close();
    } catch (e) {
      this.busy = false;
      this.setStatus(`接收登录态失败：${String(e).slice(0, 140)}`, '可点「刷新二维码」重试');
      this.schedulePoll();
    }
  }

  private async saveManual(raw: string): Promise<void> {
    let cookie = normalizeCookie(raw);
    let chk = checkCookie(cookie);
    if (!chk.ok && cookie && this.transport) {
      // 手动粘贴的场景也走一遍自动补全：wr_gid 由首页下发，通常粘贴三项就够
      try {
        cookie = normalizeCookie(await warmUpSession(this.transport, cookie));
        chk = checkCookie(cookie);
      } catch {
        /* 补全失败就按原样报缺项 */
      }
    }
    if (!chk.ok) {
      new Notice(`Cookie 不完整：${describeCookieCheck(chk)}`, 8000);
      return;
    }
    this.stopped = true;
    this.clearTimer();
    await this.opts.onSuccess(cookie);
    new Notice('已保存 cookie');
    this.close();
  }
}
