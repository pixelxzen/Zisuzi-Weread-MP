/**
 * 微信读书官方 Agent API（Bearer API Key）
 * 端点：POST https://i.weread.qq.com/api/agent/gateway
 * 能力：书架 / 书籍 / 笔记 / 阅读统计 / 推荐 / 搜索（不含公众号文章正文）
 * 取 Key：GET https://weread.qq.com/api/skills/apikeyGet （需登录 cookie）
 */

export interface HttpRespLike {
  status: number;
  text: string;
}

export type HttpFn = (
  url: string,
  headers: Record<string, string>,
  method?: string,
  body?: string,
) => Promise<HttpRespLike>;

export const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
export const SKILL_VERSION = '1.0.3';

export interface ShelfBook {
  bookId: string;
  title: string;
  author?: string;
  updateTime?: number;
}

export class AgentApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export class WereadAgentApi {
  constructor(private http: HttpFn, private apiKey: string) {}

  get hasKey(): boolean {
    return /^wrk-/.test(this.apiKey);
  }

  async gateway<T = any>(apiName: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.hasKey) throw new AgentApiError(-1, '未配置官方 API Key');
    const body = JSON.stringify({ api_name: apiName, skill_version: SKILL_VERSION, ...params });
    const resp = await this.http(
      GATEWAY,
      { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      'POST',
      body,
    );
    if (resp.status === 401 || resp.status === 403) throw new AgentApiError(-401, 'API Key 无效或已失效');
    if (resp.status !== 200) throw new AgentApiError(resp.status, `网关 HTTP ${resp.status}`);
    let json: any;
    try {
      json = JSON.parse(resp.text);
    } catch {
      throw new AgentApiError(-2, '网关返回非 JSON');
    }
    const code = json?.errcode ?? json?.errCode ?? 0;
    if (typeof code === 'number' && code !== 0) {
      throw new AgentApiError(code, `接口错误 ${code}${json?.errmsg ? '：' + json.errmsg : ''}`);
    }
    return json as T;
  }

  /** 完整书架（含书 / 有声书 / 文章收藏） */
  async shelfSync(): Promise<{ books: ShelfBook[]; albums: any[]; mp?: any }> {
    const r = await this.gateway<any>('/shelf/sync');
    return { books: r.books ?? [], albums: r.albums ?? [], mp: r.mp };
  }

  /** 书架里的公众号（bookId 以 MP_WXS_ 开头） */
  async mpAccounts(): Promise<Array<{ name: string; bookId: string }>> {
    const { books } = await this.shelfSync();
    return books
      .filter((b) => String(b.bookId || '').startsWith('MP_WXS_'))
      .map((b) => ({ name: b.title || b.bookId, bookId: b.bookId }));
  }

  /** 笔记本概览（有笔记的书） */
  async notebooks(count = 20, lastSort?: number): Promise<any> {
    return this.gateway('/user/notebooks', lastSort ? { count, lastSort } : { count });
  }

  /** 阅读统计 */
  async readData(mode: 'weekly' | 'monthly' | 'annually' | 'overall' = 'monthly'): Promise<any> {
    return this.gateway('/readdata/detail', { mode });
  }

  /** 书城搜索（scope: 0 全部 / 10 电子书 / 14 有声书 / 6 作者 / 12 全文 / 13 书单） */
  async search(keyword: string, scope = 0, count = 10): Promise<any> {
    return this.gateway('/store/search', { keyword, scope, count });
  }
}

/** 用登录态换取长期 API Key */
export async function fetchApiKey(http: HttpFn, cookie: string): Promise<string | null> {
  const resp = await http(
    'https://weread.qq.com/api/skills/apikeyGet',
    {
      Cookie: cookie,
      Referer: 'https://weread.qq.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
    },
    'GET',
  );
  if (resp.status !== 200) return null;
  try {
    const j = JSON.parse(resp.text);
    const k = j?.apikey;
    return typeof k === 'string' && k.startsWith('wrk-') ? k : null;
  } catch {
    return null;
  }
}
