/**
 * 微信读书公众号接口客户端（纯 HTTP，不依赖浏览器 / Node / Electron）
 * 依赖注入 httpRequest，便于在 Obsidian(requestUrl) 与 Node(fetch) 之间共用、并做单测。
 */

export interface ArticleItem {
  reviewId: string;
  title: string;
  time: number;          // 秒级时间戳
  readNum?: number;
  likeNum?: number;
  picUrl?: string;
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

/** 完整性检查：缺 wr_gid 会稳定拿到 -2012（实测） */
export function checkCookie(cookie: string): { ok: boolean; missing: string[] } {
  const need = ['wr_vid', 'wr_skey', 'wr_rt', 'wr_gid'];
  const have = new Set(
    normalizeCookie(cookie)
      .split(';')
      .map((s) => s.split('=')[0].trim()),
  );
  const missing = need.filter((n) => !have.has(n));
  return { ok: missing.length === 0, missing };
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

function assertNoRisk(json: any, what: string): void {
  const code = json?.errcode ?? json?.errCode;
  if (typeof code === 'number' && code !== 0) {
    if (RISK_CODES.includes(code)) throw new RiskError(code, `${what} 风控/登录失效 (${code})`);
    throw new Error(`${what} 接口错误 ${code}: ${json?.errmsg ?? json?.errMsg ?? ''}`);
  }
}

/** 解析一页列表响应 */
export function parseArticleList(json: any): ArticleItem[] {
  const out: ArticleItem[] = [];
  for (const rv of json?.reviews ?? []) {
    for (const sub of rv?.subReviews ?? []) {
      const r = sub?.review ?? {};
      const info = r.mpInfo ?? {};
      const rid: string = r.reviewId || '';
      if (!rid) continue;
      out.push({
        reviewId: rid,
        title: info.title || '(无标题)',
        time: Number(info.time ?? r.createTime ?? 0),
        readNum: typeof info.readNum === 'number' ? info.readNum : undefined,
        likeNum: typeof info.likeNum === 'number' ? info.likeNum : undefined,
        picUrl: info.pic_url || info.picUrl || undefined,
        mpName: info.mp_name || '',
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
    if (r.status !== 200) throw new Error(`列表 HTTP ${r.status}`);
    let json: any;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new Error('列表返回非 JSON（可能被拦）');
    }
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
    return r.text;
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
