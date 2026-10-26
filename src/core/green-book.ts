/**
 * 小绿书（微信「图片消息」）解析 —— 纯函数，无 DOM，可单测。
 *
 * 为什么需要它：微信读书的 /web/mp/content 对图片消息只回 ~31 KB 空壳
 * （实测：js_content 0、<img> 0、mmbiz.qpic 0、window.biz/mid/sn 全空），
 * 所以小绿书必须回原页 mp.weixin.qq.com 抓。原页的图不在 DOM 的 <img> 里，
 * 在 window.picture_page_info_list 这个 JS 字面量里：
 *
 *   picture_page_info_list: [
 *     { cdn_url: 'https://mmbiz.qpic.cn/mmbiz_png/...', width: '840' * 1, height: '1206' * 1,
 *       is_qr_code: '0' * 1, share_cover: { cdn_url: '...' }, watermark_info: { cdn_url: '...' } },
 *     ...
 *   ]
 *
 * 关键坑（2026-10-26 实测《1024｜程序员的第十次幂》）：
 *   1. 图片后缀 mmbiz_svg 不是装饰，可能就是内页本体（SVG 长图），必须按 .svg 存；
 *      当 jpg 下载会得到一堆打不开的坏图。
 *   2. 每个条目内部还嵌着 share_cover / watermark_info 的 cdn_url，
 *      取「第一个 cdn_url」才是该条目自己的图，取错会多出一堆截图。
 *   3. width / height 写成 `'840' * 1` 字符串乘一，取值要按字符串解析。
 */

export interface PicturePage {
  url: string;
  width: number;
  height: number;
  /** 二维码图（文末引流码），不该进正文 */
  isQr: boolean;
  /** bitmap = 普通位图；svg = 矢量内页；other = 未知 */
  kind: 'bitmap' | 'svg' | 'other';
}

export interface GreenBookMeta {
  title?: string;
  author?: string;
  digest?: string;
  /** 发布时间（秒） */
  publishTs: number;
}

/** 从 HTML 里取出 `key: [ ... ]` / `key = [ ... ]` 的数组字面量文本（按括号平衡，跳过字符串内部）
 *  真实页面两种写法都有，但 `window.picture_page_info_list = ((…).slice(0,20))` 这种赋值是「取数据对象」
 *  而不是数据本身 —— 所以只接受数组里含 cdn_url 的那一处，避免抓到切片代码。 */
export function extractJsArray(html: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '\\s*[:=]\\s*\\[', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = html.indexOf('[', m.index + m[0].length - 1);
    if (start < 0) continue;
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (quote) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) {
          const arr = html.slice(start, i + 1);
          if (arr.includes('cdn_url')) return arr; // 只认真正的数据数组
          break;
        }
      }
    }
  }
  return '';
}

/** 拆出数组里的顶层 { ... } 对象文本 */
export function splitObjects(arrayText: string): string[] {
  const out: string[] = [];
  let k = 0;
  while (k < arrayText.length) {
    const a = arrayText.indexOf('{', k);
    if (a < 0) break;
    let depth = 0;
    let quote: string | null = null;
    let b = -1;
    for (let i = a; i < arrayText.length; i++) {
      const c = arrayText[i];
      if (quote) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          b = i + 1;
          break;
        }
      }
    }
    if (b < 0) break;
    out.push(arrayText.slice(a, b));
    k = b;
  }
  return out;
}

function cleanUrl(u: string): string {
  return u.replace(/\\x26amp;/gi, '&').replace(/\\x26/gi, '&').replace(/&amp;/gi, '&').trim();
}

function firstCdnUrl(objText: string): string {
  // 只取该对象里「第一个」cdn_url —— 它就是本条目自己的图；
  // 后面的 share_cover / watermark_info 是分享图与水印图，不该当正文。
  const m = /cdn_url\s*:\s*['"]([^'"]+)['"]/.exec(objText);
  return m ? cleanUrl(m[1]) : '';
}

function numField(objText: string, name: string): number {
  const m = new RegExp(name + "\\s*:\\s*'?(\\d+)").exec(objText);
  return m ? parseInt(m[1], 10) : 0;
}

function strField(objText: string, name: string): string {
  const m = new RegExp(name + "\\s*:\\s*['\"]([^'\"]*)['\"]").exec(objText);
  return m ? cleanUrl(m[1]) : '';
}

/** 把 picture_page_info_list 解析成图片清单（已过滤装饰/二维码由调用方决定） */
export function parsePicturePages(html: string): PicturePage[] {
  const arr = extractJsArray(html, 'picture_page_info_list');
  if (!arr) return [];
  const pages: PicturePage[] = [];
  const seen = new Set<string>();
  for (const obj of splitObjects(arr)) {
    const url = firstCdnUrl(obj);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const kind: PicturePage['kind'] = /mmbiz_svg/i.test(url)
      ? 'svg'
      : /mmbiz_(?:jpg|jpeg|png|gif|webp)/i.test(url)
        ? 'bitmap'
        : 'other';
    pages.push({
      url,
      width: numField(obj, 'width'),
      height: numField(obj, 'height'),
      isQr: numField(obj, 'is_qr_code') === 1,
      kind,
    });
  }
  return pages;
}

/** 该页是不是小绿书：有 picture_page_info_list 且没有 js_content 正文容器 */
export function detectGreenBook(html: string): { green: boolean; pages: PicturePage[] } {
  const pages = parsePicturePages(html);
  const hasRichText = /id=["']js_content["']/i.test(html);
  return { green: pages.length > 0 && !hasRichText, pages };
}

/** 从原页 meta / 脚本里抽标题、作者、摘要、时间 */
export function greenBookMeta(html: string): GreenBookMeta {
  const pick = (re: RegExp): string | undefined => {
    const m = re.exec(html);
    return m ? cleanUrl(m[1]).replace(/<[^>]+>/g, '').trim() || undefined : undefined;
  };
  const title =
    pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ||
    pick(/<meta\s+name=["']twitter:title["']\s+content=["']([^"']*)["']/i) ||
    pick(/^\s*var\s+msg_title\s*=\s*['"]([^'"]*)['"]/im);
  const author =
    pick(/<meta\s+name=["']author["']\s+content=["']([^"']*)["']/i) ||
    pick(/^\s*var\s+nickname\s*=\s*['"]([^'"]*)['"]/im);
  const digest =
    pick(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ||
    pick(/^\s*var\s+msg_desc\s*=\s*['"]([^'"]*)['"]/im);
  const t = /var\s+ct\s*=\s*["'](\d{9,})["']/.exec(html) || /create_time\s*:\s*['"](\d{9,})/.exec(html);
  return { title, author, digest, publishTs: t ? parseInt(t[1], 10) : 0 };
}

/** 该页应存的扩展名 */
export function pageExt(p: PicturePage): string {
  if (p.kind === 'svg') return 'svg';
  const m = /mmbiz_(jpg|jpeg|png|gif|webp)/i.exec(p.url);
  if (!m) return 'png';
  const k = m[1].toLowerCase();
  return k === 'jpeg' ? 'jpg' : k;
}

/** 真正要落盘的页面：排除二维码，保留 svg + 位图 */
export function contentPages(pages: PicturePage[]): PicturePage[] {
  return pages.filter((p) => !p.isQr && p.kind !== 'other');
}
