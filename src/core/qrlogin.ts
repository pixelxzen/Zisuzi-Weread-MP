/**
 * 微信读书「扫码登录」——纯 HTTP 实现，不依赖 Electron / webview / 浏览器会话。
 *
 * 走的是微信读书官方扫码链路（比微信 OAuth 稳，且不受 wxCode 的 -2013 影响）：
 *
 *   ① GET  weread.qq.com/api/auth/getLoginUid            → uid
 *   ② 二维码内容 = https://weread.qq.com/web/confirm?uid=<uid>（本地生成二维码图片）
 *   ③ GET  weread.qq.com/api/auth/getLoginInfo?uid=&otp= → 长轮询：
 *        logicCode 0 等待 / 1 已扫 / succeed=true 成功（返回 vid + accessToken + refreshToken）
 *        实测：服务端会把一次请求 hold 约 55 秒，然后返回
 *        {succeed:false, logicCode:"LOGIN_TIMEOUT", canRetry:false}。
 *        这只是「本轮没动静」，不是二维码过期 —— 同一个 uid 可以一直续查
 *        （实测同一 uid 连续两轮都正常 hold 55 秒）。所以 TIMEOUT 要当 waiting 处理，
 *        真正的过期用 logicCode 里的 EXPIRE 判断。
 *   ④ 成功响应的 Set-Cookie 与 JSON 令牌合成 wr_vid / wr_skey / wr_rt / wr_gid
 *
 * 原先基于微信 OAuth + /api/login/wxCode 的方案实测稳定返回 401 / -2013，已弃用。
 */

import qrcode from 'qrcode-generator';
import { WEREAD_UA as UA } from './weread';

export const WEREAD_LOGIN_UID_URL = 'https://weread.qq.com/api/auth/getLoginUid';
export const WEREAD_LOGIN_INFO_URL = 'https://weread.qq.com/api/auth/getLoginInfo';

/* -------------------------------- 传输层 -------------------------------- */

export interface QrHttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface QrHttpInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface QrTransport {
  request(url: string, init?: QrHttpInit): Promise<QrHttpResult>;
}

interface NodeResponse {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: { toString(enc?: string): string }) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (e: unknown) => void): void;
  setTimeout?(ms: number, cb: () => void): void;
}

interface NodeRequest {
  on(event: 'error', cb: (e: unknown) => void): void;
  on(event: 'timeout', cb: () => void): void;
  write(chunk: string): void;
  end(): void;
  destroy(err?: Error): void;
  setTimeout?(ms: number, cb: () => void): void;
}

interface HttpsModule {
  request(options: Record<string, unknown>, cb: (res: NodeResponse) => void): NodeRequest;
}

/** 运行时探测：Obsidian 桌面端有 Node，移动端没有 */
export function hasNodeHttp(): boolean {
  try {
    const w = window as unknown as { require?: (m: string) => unknown };
    if (typeof w.require !== 'function') return false;
    return !!w.require('https');
  } catch {
    return false;
  }
}

/** 用 Node https 发请求：只有它能读到 Set-Cookie（Obsidian requestUrl 会丢掉） */
export function createNodeTransport(): QrTransport | null {
  let https: HttpsModule | null = null;
  try {
    const w = window as unknown as { require?: (m: string) => unknown };
    https = typeof w.require === 'function' ? (w.require('https') as HttpsModule) : null;
  } catch {
    https = null;
  }
  if (!https?.request) return null;
  const mod = https;

  return {
    request(url, init = {}) {
      return new Promise<QrHttpResult>((resolve, reject) => {
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          reject(new Error(`非法地址：${url}`));
          return;
        }
        const body = init.body ?? '';
        const headers: Record<string, string> = {
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...init.headers,
        };
        if (body) headers['Content-Length'] = String(new TextEncoder().encode(body).length);

        const req = mod.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: init.method ?? (body ? 'POST' : 'GET'),
            headers,
          },
          (res) => {
            const chunks: string[] = [];
            res.on('data', (c) => chunks.push(c.toString('utf8')));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers ?? {},
                text: chunks.join(''),
              }),
            );
            res.on('error', reject);
          },
        );
        const timeout = init.timeoutMs ?? 15000;
        req.setTimeout?.(timeout, () => {
          req.destroy(new Error(`请求超时（${timeout}ms）`));
        });
        req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    },
  };
}

/* -------------------------------- 纯函数 -------------------------------- */

/** 二维码内容：用微信读书 App / 微信扫这个地址完成确认 */
/**
 * 二维码内容。官方网页端（app.6dde5475.js）的实际拼法是：
 *   https://weread.qq.com/web/confirm?pf=<1|2>&uid=<uid>
 * 其中 pf = (当前平台是 iOS ? '1' : '2')，通过 encodeURIComponent 包裹。
 * 插件跑在桌面端（Windows/macOS/Linux），一律取 2；缺这个参数服务端可能落到默认分支。
 */
export function buildConfirmUrl(uid: string, pf: '1' | '2' = '2'): string {
  return `https://weread.qq.com/web/confirm?pf=${encodeURIComponent(pf)}&uid=${encodeURIComponent(uid)}`;
}

/** 在本地生成二维码（GIF data URL），不依赖任何第三方出图服务 */
export function renderQrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

export type QrPollStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'need-otp' | 'unknown';

export interface QrPollResult {
  status: QrPollStatus;
  /** 仅 confirmed 时有值 */
  cookie?: string;
  /** 服务端原始返回，便于排障 */
  raw: string;
}

/** 兼容 {data:{...}} 与扁平两种结构 */
function innerOf(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return {};
  const o = json as Record<string, unknown>;
  const d = o.data;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

function pickStr2(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && v) return String(v);
  }
  return '';
}

/** 解析长轮询响应 */
export function parseLoginInfo(text: string): QrPollResult {
  const raw = text.trim().slice(0, 300);
  if (!text.trim()) return { status: 'waiting', raw: '(empty)' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: 'unknown', raw };
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const inner = innerOf(json);
  const succeed = o.succeed ?? inner.succeed;
  const logic = o.logicCode ?? inner.logicCode;

  if (succeed === true || succeed === 1 || succeed === 'true') {
    return { status: 'confirmed', raw, cookie: cookieFromLoginBody(text) };
  }
  const lc = typeof logic === 'number' ? String(logic) : typeof logic === 'string' ? logic : '';
  if (lc === '1') return { status: 'scanned', raw };
  if (lc === '0' || lc === '') return { status: 'waiting', raw };
  const up = lc.toUpperCase();
  // LOGIN_TIMEOUT 只是「本轮长轮询到点返回」，同一 uid 仍可续查，不能当过期
  if (up.includes('TIMEOUT')) return { status: 'waiting', raw };
  if (up.includes('EXPIRE')) return { status: 'expired', raw };
  if (up.includes('OTP')) return { status: 'need-otp', raw };
  return { status: 'unknown', raw };
}

/** Set-Cookie 数组 → 请求头用的 cookie 串（后面的值覆盖前面的同名 cookie） */
export function cookieFromSetCookie(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const first = line.split(';')[0] ?? '';
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!name || /^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) continue;
    if (!value) continue;
    jar.set(name, value);
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 从 getLoginInfo 的成功响应里拼 cookie。
 * 实测 accessToken 可能很短，refreshToken 才是长令牌（对应 wr_rt）；
 * 优先用响应里真正下发的 wr_skey，其次才用 JSON 里的令牌。
 */
export function cookieFromLoginBody(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return '';
  }
  if (!json || typeof json !== 'object') return '';
  const o = json as Record<string, unknown>;
  const inner = innerOf(json);
  const user = (o.user && typeof o.user === 'object' ? o.user : {}) as Record<string, unknown>;

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = pickStr2(o[k], inner[k], user[k]);
      if (v) return v;
    }
    return '';
  };

  const vid = pick('webLoginVid', 'vid', 'userVid', 'user_vid', 'wr_vid');
  const access = pick('accessToken', 'access_token', 'token', 'wr_skey', 'skey');
  const refresh = pick('refreshToken', 'refresh_token', 'wr_rt');
  if (!vid) return '';

  const parts = [`wr_vid=${vid}`];
  // 服务端成功响应里下发的令牌直接采用；若被判定为短占位值，warmUpSession 会再用
  // 服务端 Set-Cookie 覆盖成真正的 wr_skey
  if (access) parts.push(`wr_skey=${access}`);
  if (refresh) parts.push(`wr_rt=${encodeURIComponent(refresh)}`);
  const gid = pick('gid', 'wr_gid');
  if (gid) parts.push(`wr_gid=${gid}`);
  return parts.join('; ');
}

/** 合并多段 cookie 串，后出现的同名项覆盖前面的 */
export function mergeCookieStrings(...parts: string[]): string {
  const jar = new Map<string, string>();
  for (const part of parts) {
    for (const seg of (part || '').split(';')) {
      const i = seg.indexOf('=');
      if (i <= 0) continue;
      const k = seg.slice(0, i).trim();
      const v = seg.slice(i + 1).trim();
      if (!k || !v) continue;
      jar.set(k, v);
    }
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
}

function headerValues(h: QrHttpResult['headers'], key: string): string[] {
  const v = h[key] ?? h[key.toLowerCase()];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/* -------------------------------- 流程 -------------------------------- */

export interface QrStart {
  uuid: string;
  imageUrl: string;
  /** 二维码里编码的地址，便于用户手动打开 */
  confirmUrl: string;
  requestId?: string;
  cookie?: string;
}

/**
 * 首页 SSR 里带的请求校验头（扫码链路本身不用，保留给其它 /api 请求复用）。
 * Nuxt payload 形如 `{"requestId":6014},"6K-oriFYlKKtBEabmRDQW"`。
 */
export function parseSsrRequestId(html: string): string | null {
  const m = /\{"requestId":\d+\}\s*,\s*"([^"]{6,64})"/.exec(html);
  if (m) return m[1];
  const m2 = /"requestId"\s*:\s*"([^"]{6,64})"/.exec(html);
  return m2 ? m2[1] : null;
}

/** ① 取 uid 并生成本地二维码 */
export async function startQrLogin(t: QrTransport): Promise<QrStart> {
  let requestId: string | undefined;
  let cookie = '';
  try {
    const home = await t.request('https://weread.qq.com/', {
      headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://weread.qq.com/' },
    });
    requestId = parseSsrRequestId(home.text) ?? undefined;
    cookie = cookieFromSetCookie(headerValues(home.headers, 'set-cookie'));
  } catch {
    /* 首页失败不影响取 uid */
  }

  const r = await t.request(WEREAD_LOGIN_UID_URL, {
    headers: { Referer: 'https://weread.qq.com/', Accept: 'application/json, text/plain, */*' },
    timeoutMs: 15000,
  });
  if (r.status !== 200) throw new Error(`获取登录 uid 失败：HTTP ${r.status}`);
  let uid = '';
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const data = (j.data && typeof j.data === 'object' ? j.data : {}) as Record<string, unknown>;
    uid = pickStr2(j.uid, data.uid);
  } catch {
    /* 下面统一报错 */
  }
  if (!uid) throw new Error(`登录 uid 解析失败：${r.text.slice(0, 120)}`);

  const confirmUrl = buildConfirmUrl(uid);
  return { uuid: uid, imageUrl: renderQrDataUrl(confirmUrl), confirmUrl, requestId, cookie };
}

/** ③ 长轮询扫码状态（服务端最多挂 70s 才返回，超时按「继续等待」处理） */
export async function pollQrStatus(t: QrTransport, uid: string): Promise<QrPollResult> {
  const url = `${WEREAD_LOGIN_INFO_URL}?uid=${encodeURIComponent(uid)}&otp=`;
  let r: QrHttpResult;
  try {
    r = await t.request(url, {
      headers: { Referer: 'https://weread.qq.com/', Accept: 'application/json, text/plain, */*' },
      timeoutMs: 80000,
    });
  } catch {
    return { status: 'waiting', raw: '长轮询超时' };
  }
  if (r.status !== 200) return { status: 'unknown', raw: `HTTP ${r.status}` };
  const parsed = parseLoginInfo(r.text);
  if (parsed.status === 'confirmed') {
    const fromHeader = cookieFromSetCookie(headerValues(r.headers, 'set-cookie'));
    const merged = mergeCookieStrings(fromHeader, parsed.cookie ?? '');
    return { ...parsed, cookie: merged };
  }
  return parsed;
}

/**
 * 补全会话级 cookie。
 *
 * 实测（2026-10-19）：`wr_gid` **只由首页下发**，且一次下发两条（后一条覆盖前一条）：
 *   GET https://weread.qq.com/  →  Set-Cookie: wr_gid=289906200 | wr_gid=256166121
 * 而 `/web/user`、`/web/shelf/sync`、`/api/auth/getLoginUid` 都**不下发**任何 Set-Cookie。
 * 所以首页必须单独探一次，否则扫码成功后永远缺 wr_gid。
 *
 * wr_gid 是设备级游客标识，与登录态无关，匿名拿到的同样可用；
 * 只在本地确实没有时才去拿，避免覆盖用户手动粘贴的有效值。
 */
export async function warmUpSession(t: QrTransport, cookie: string): Promise<string> {
  let merged = cookie;

  const probe = async (url: string, accept: string, sendCookie: boolean): Promise<void> => {
    try {
      const r = await t.request(url, {
        headers: {
          ...(sendCookie ? { Cookie: merged } : {}),
          Referer: 'https://weread.qq.com/',
          Accept: accept,
        },
      });
      const extra = cookieFromSetCookie(headerValues(r.headers, 'set-cookie'));
      if (extra) merged = mergeCookieStrings(merged, extra);
    } catch {
      /* 补全失败不影响主流程 */
    }
  };

  if (!hasCookieValue(merged, 'wr_gid')) {
    await probe('https://weread.qq.com/', 'text/html,application/xhtml+xml', false);
  }
  await probe('https://weread.qq.com/web/user?userVid=0', 'application/json, text/plain, */*', true);
  await probe('https://weread.qq.com/web/shelf/sync?synckey=0', 'application/json, text/plain, */*', true);
  return merged;
}

/** cookie 串里是否已有某个非空键 */
function hasCookieValue(cookie: string, name: string): boolean {
  for (const seg of cookie.split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    if (seg.slice(0, i).trim() === name && seg.slice(i + 1).trim()) return true;
  }
  return false;
}

/** 二进制 → base64（保留给需要内联图片的场景） */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
