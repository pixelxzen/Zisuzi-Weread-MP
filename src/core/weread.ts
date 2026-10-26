/**
 * 微信读书公众号接口客户端（纯 HTTP，不依赖浏览器 / Node / Electron）
 * 依赖注入 httpRequest，便于在 Obsidian(requestUrl) 与 Node(fetch) 之间共用、并做单测。
 */

import { isObj, parseJson, pickArr, pickNum, pickObj, pickStr } from './typed';

export interface ArticleItem {
  reviewId: string;
  title: string;
  time: number;          // 秒级时间戳
  readNum?: number;
  likeNum?: number;
  picUrl?: string;
  /** 列表接口自带的摘要（图片笔记唯一可用的正文线索） */
  digest?: string;
  mpName: string;
}

export interface HttpResp {
  status: number;
  text: string;
  bytes: ArrayBuffer;
}

export type HttpFn = (url: string, headers: Record<string, string>) => Promise<HttpResp>;

export const RISK_CODES = [-2010, -2012, -2041];

export class RiskError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

export const WEREAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 用户粘贴的 cookie 串 → 规范化 header 值 */
export function normalizeCookie(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

export interface CookieCheck {
  ok: boolean;
  /** 必需字段整个缺失 */
  missing: string[];
  /** 字段在，但值是空的（这类 cookie 格式合法、接口必定 -2012） */
  empty: string[];
}

/**
 * 完整性检查。
 * 两条都会稳定拿到 -2012，必须一起判：
 *  - 缺 wr_gid 等必需字段；
 *  - 必需字段存在但值为空（实测：从没登录过的会话读出来的就是这种「四项齐、值全空」，
 *    旧实现只看键存在 → 判 ok → 界面显示已登录，一抓就报过期）。
 */
export function checkCookie(cookie: string): CookieCheck {
  const norm = normalizeCookie(cookie);
  const kv = new Map<string, string>();
  for (const part of norm.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    kv.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const need = ['wr_vid', 'wr_skey', 'wr_rt', 'wr_gid'];
  const missing = need.filter((n) => !kv.has(n));
  const empty = need.filter((n) => kv.has(n) && !kv.get(n));
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

/** 把 checkCookie 的结论翻成人话（给 Notice / 状态条用） */
export function describeCookieCheck(chk: CookieCheck): string {
  const parts: string[] = [];
  if (chk.missing.length) parts.push(`缺 ${chk.missing.join(', ')}`);
  if (chk.empty.length) parts.push(`${chk.empty.join(', ')} 的值为空`);
  return parts.join('；');
}

export function baseHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: normalizeCookie(cookie),
    'User-Agent': WEREAD_UA,
    Referer: 'https://weread.qq.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
}

export interface WereadProfile {
  name: string;
  avatar: string;
  avatarPath?: string;
  vid: string;
  desc?: string;
}

/** 登录用户资料（昵称/头像/简介）：GET /web/user?userVid=<wr_vid> */
/**
 * 拿「当前登录用户」的资料，不依赖 cookie 里的 wr_vid。
 * 用于 session 自带登录态、但旧 cookie 里的 vid 已过期的场景（切换账号后）。
 */
export async function fetchCurrentUser(http: HttpFn, cookie: string): Promise<WereadProfile | null> {
  const ck = normalizeCookie(cookie);
  const cands = [
    'https://weread.qq.com/api/user/info',
    'https://weread.qq.com/api/user/profile',
    'https://weread.qq.com/web/user?userVid=0',
    'https://weread.qq.com/web/user?userVid=',
  ];
  for (const u of cands) {
    try {
      const r = await http(u, {
        Cookie: ck,
        'User-Agent': WEREAD_UA,
        Referer: 'https://weread.qq.com/',
        Accept: 'application/json, text/plain, */*',
      });
      if (r.status !== 200 || !r.text.trim().startsWith('{')) continue;
      const j = parseJson(r.text);
      const user = pickObj(j, 'user');
      const name = pickStr(j, 'name', 'userName', 'nickName') || pickStr(user, 'name');
      if (!name) continue;
      return {
        name,
        avatar: pickStr(j, 'avatar', 'avatarUrl') || pickStr(user, 'avatar'),
        vid: pickStr(j, 'userVid', 'vid') || pickStr(user, 'userVid'),
        desc: pickStr(j, 'vDesc') || pickStr(user, 'vDesc'),
      };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

export async function fetchProfile(http: HttpFn, cookie: string): Promise<WereadProfile | null> {
  const ck = normalizeCookie(cookie);
  const vid = (ck.split(';').map((s) => s.trim()).find((s) => s.startsWith('wr_vid=')) || '').slice('wr_vid='.length);
  if (!vid) return null;
  const r = await http(`https://weread.qq.com/web/user?userVid=${encodeURIComponent(vid)}`, {
    Cookie: ck,
    'User-Agent': WEREAD_UA,
    Referer: 'https://weread.qq.com/',
    Accept: 'application/json, text/plain, */*',
  });
  if (r.status !== 200) return null;
  try {
    const j = parseJson(r.text);
    return {
      name: pickStr(j, 'name'),
      avatar: pickStr(j, 'avatar'),
      vid: pickStr(j, 'userVid') || vid,
      desc: pickStr(j, 'vDesc'),
    };
  } catch {
    return null;
  }
}

/**
 * 风控码 → 人话。
 * 实测（2026-10-17）：同一份 cookie 上 /web/user 与 /api/skills/apikeyGet 都正常、
 * 只有 /web/mp/articles 返回 -2041，且官方网页版打开公众号时页面自己也报 -2041 →
 * -2041 不是"登录失效"，是"公众号接口对该账号关闭/限流"。别再把两者混为一谈。
 */
export function describeRisk(code: number, what = ''): string {
  const pre = what ? `${what}：` : '';
  switch (code) {
    case -2010:
      return `${pre}未登录（cookie 缺失或已失效）(-2010)`;
    case -2012:
      return `${pre}登录态过期，需重新扫码 (-2012)`;
    case -2041:
      return `${pre}公众号接口对该账号受限 (-2041)：登录态本身有效，可在手机 App 打开一次公众号解除，或等数小时冷却`;
    default:
      return `${pre}接口错误 ${code}`;
  }
}

function assertNoRisk(json: unknown, what: string): void {
  // 服务端两种写法都出现过：errcode（小写 c）和 errCode（大写 C），漏判会把 -2012 吞掉
  const raw = isObj(json) ? (json.errcode ?? json.errCode) : undefined;
  const code = typeof raw === 'number' ? raw : 0;
  if (code !== 0) {
    if (RISK_CODES.includes(code)) throw new RiskError(code, describeRisk(code, what));
    throw new Error(`${what} 接口错误 ${code}: ${pickStr(json, 'errmsg', 'errMsg')}`);
  }
}

export interface AccessProbe {
  cookieOk: boolean;
  missing: string[];
  account: string | null;
  listOk: boolean;
  listCode: number;
  verdict: 'ok' | 'no-cookie' | 'expired' | 'restricted' | 'unknown';
  hint: string;
}

/**
 * 接口自检：把"cookie 少字段 / 会话过期 / 公众号接口被限"三种情况分开，
 * 不再一律报"登录失效"。
 * @param bookId 探测用公众号，默认 'mpbook'（文章收藏），任何号返回码都一致
 */
export async function probeAccess(http: HttpFn, cookie: string, bookId = 'mpbook'): Promise<AccessProbe> {
  const norm = normalizeCookie(cookie || '');
  const chk = checkCookie(norm);
  const out: AccessProbe = {
    cookieOk: chk.ok,
    missing: chk.missing,
    account: null,
    listOk: false,
    listCode: 0,
    verdict: 'unknown',
    hint: '',
  };
  if (!norm) {
    out.verdict = 'no-cookie';
    out.hint = '还没登录：先在设置里扫码登录，或粘贴四项 Cookie';
    return out;
  }
  if (!chk.ok) {
    out.verdict = 'expired';
    out.hint = chk.empty.length
      ? `Cookie 不完整：${describeCookieCheck(chk)}。值为空说明这份登录态没真正拿到，重新扫码即可`
      : `Cookie 缺 ${chk.missing.join(', ')}（缺 wr_gid 会稳定报 -2012）`;
  }

  // ① 会话是否还活着（只看 /web/user，不看 mp 接口）
  const prof = await fetchProfile(http, norm).catch(() => null);
  out.account = prof?.name || null;

  // ② 公众号列表接口
  try {
    const r = await http(
      `https://weread.qq.com/web/mp/articles?bookId=${encodeURIComponent(bookId)}&offset=0`,
      baseHeaders(norm),
    );
    let code = 0;
    if (r.status === 0) {
      code = -9001; // 超时/无响应，不能当成 0（0 会被误判成"可以抓"）
    } else if (r.status !== 200) {
      code = -r.status;
    } else {
      try {
        const j = parseJson(r.text);
        const raw = isObj(j) ? (j.errCode ?? j.errcode) : undefined;
        code = typeof raw === 'number' ? raw : 0;
      } catch {
        code = -2;
      }
    }
    out.listCode = code;
    out.listOk = code === 0;
  } catch {
    out.listCode = -1;
  }

  if (out.listOk) {
    out.verdict = 'ok';
    out.hint = '登录态与公众号接口都正常，可以抓';
    return out;
  }
  if (!out.account) {
    out.verdict = 'expired';
    out.hint = '登录态已失效，重新扫码即可';
    return out;
  }
  if (out.listCode === -2041) {
    out.verdict = 'restricted';
    out.hint = '登录态有效（能看到账号昵称），但公众号接口对该账号受限：手机 App 打开一次公众号，或等数小时冷却；换账号也能绕开';
    return out;
  }
  if (out.listCode === -2010 || out.listCode === -2012) {
    out.verdict = 'expired';
    out.hint = `会话过期 (${out.listCode})，重新扫码`;
    return out;
  }
  out.hint = `列表接口返回 ${out.listCode}，未知错误，先看 errLog`;
  return out;
}

/** 解析一页列表响应 */
export function parseArticleList(json: unknown): ArticleItem[] {
  const out: ArticleItem[] = [];
  for (const rv of pickArr(json, 'reviews')) {
    for (const sub of pickArr(rv, 'subReviews')) {
      const review = pickObj(sub, 'review');
      const info = pickObj(review, 'mpInfo');
      const reviewId = pickStr(review, 'reviewId');
      if (!reviewId) continue;
      const readNum = pickNum(info, 'readNum');
      const likeNum = pickNum(info, 'likeNum');
      out.push({
        reviewId,
        title: pickStr(info, 'title') || '(无标题)',
        time: pickNum(info, 'time') || pickNum(review, 'createTime'),
        readNum: readNum || undefined,
        likeNum: likeNum || undefined,
        picUrl: pickStr(info, 'pic_url', 'picUrl') || undefined,
        digest: pickStr(info, 'content').trim() || undefined,
        mpName: pickStr(info, 'mp_name'),
      });
    }
  }
  return out;
}

export class WereadClient {
  constructor(private http: HttpFn, private cookie: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { ...baseHeaders(this.cookie), ...extra };
  }

  async listArticles(bookId: string, offset = 0): Promise<ArticleItem[]> {
    const url = `https://weread.qq.com/web/mp/articles?bookId=${encodeURIComponent(bookId)}&offset=${offset}`;
    const r = await this.http(url, this.headers());
    if (r.status === 0) throw new Error('列表 请求超时/无响应（20s）');
    if (r.status !== 200) throw new Error(`列表 HTTP ${r.status}`);
    const json = parseJson(r.text);
    if (json === null) throw new Error('列表返回非 JSON（可能被拦）');
    assertNoRisk(json, '列表');
    return parseArticleList(json);
  }

  /** 翻多页，返回按时间倒序的条目（去重） */
  async listArticlesPages(bookId: string, pages: number, onPage?: (n: number, items: ArticleItem[]) => void): Promise<ArticleItem[]> {
    const seen = new Set<string>();
    const all: ArticleItem[] = [];
    for (let p = 0; p < Math.max(1, pages); p++) {
      const items = await this.listArticles(bookId, p * 20);
      if (!items.length) break;
      let added = 0;
      for (const it of items) {
        if (seen.has(it.reviewId)) continue;
        seen.add(it.reviewId);
        all.push(it);
        added++;
      }
      onPage?.(p, items);
      if (added === 0) break; // 翻到重复页=到底
    }
    return all;
  }

  async getContentHtml(reviewId: string): Promise<string> {
    const url = `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`;
    const r = await this.http(url, this.headers());
    if (r.status !== 200) throw new Error(`正文 HTTP ${r.status}`);
    // 正文正常返回的是 HTML 文档；登录失效/受限时返回的是 JSON：{"errCode":-2012,...}
    // 不判这一层，错误体就会被当成「空正文」，一路掉进小绿书分支，
    // 静默写出一篇只有封面+摘要的半截笔记（2026-10-26 实测踩到：195 切片全丢、无任何报错）。
    // 这里必须 fail-closed：宁可这一篇失败并提示扫码，也不能产出假笔记。
    const t = r.text;
    if (t.trimStart().startsWith('{')) {
      let j: unknown = null;
      try {
        j = JSON.parse(t);
      } catch {
        /* 不是完整 JSON，走下面兜底 */
      }
      if (isObj(j) && (j.errcode !== undefined || j.errCode !== undefined)) {
        assertNoRisk(j, '正文'); // 风控码 → RiskError(-2012)，UI 会提示重新扫码
      }
      throw new Error('正文接口返回异常（不是 HTML 文档）');
    }
    return t;
  }

  /** 尽力把微信播放器 iframe 解析成直链 mp4；拿不到就返回原 url */
  /** 尽力把微信播放器 iframe 解析成直链 mp4；拿不到就返回原 url */
  async resolveVideo(url: string): Promise<string> {
    if (/\.(mp4|m3u8)(\?|$)/i.test(url)) return url;
    const vid = /[?&]vid=([A-Za-z0-9_-]+)/.exec(url)?.[1];
    if (!vid) return url;
    try {
      const api = `https://mp.weixin.qq.com/mp/videoplayer?action=get_mp_video_play_url&preview=0&vid=${vid}`;
      const r = await this.http(api, {
        'User-Agent': WEREAD_UA,
        Referer: 'https://mp.weixin.qq.com/',
        Accept: '*/*',
      });
      if (r.status !== 200) return url;
      const m =
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/.exec(r.text) ||
        /url_info[\s\S]{0,600}?"url"\s*:\s*"([^"]+)"/.exec(r.text);
      if (!m) return url;
      const direct = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
      return /^https?:/.test(direct) ? direct : url;
    } catch {
      return url;
    }
  }

  /** 下载音频 / 视频二进制（需 mp.weixin Referer） */
  async fetchMedia(src: string): Promise<ArrayBuffer> {
    const r = await this.http(src, {
      'User-Agent': WEREAD_UA,
      Referer: 'https://mp.weixin.qq.com/',
      Accept: '*/*',
    });
    if (r.status !== 200) throw new Error(`媒体 HTTP ${r.status}`);
    return r.bytes;
  }

  /** 下载图片（微信 CDN 需要 mp.weixin 的 Referer） */
  async fetchImage(src: string): Promise<ArrayBuffer> {
    const r = await this.http(src, {
      'User-Agent': WEREAD_UA,
      Referer: 'https://mp.weixin.qq.com/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    });
    if (r.status !== 200) throw new Error(`图片 HTTP ${r.status}`);
    return r.bytes;
  }
}
