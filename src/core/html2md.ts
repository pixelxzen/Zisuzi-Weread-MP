/**
 * 微信读书正文 HTML → Markdown（无 DOM 依赖，可单测）
 * 只保留阅读价值：标题/段落/引用/列表/代码/图片/加粗斜体/链接。
 */

export interface ImageRef {
  src: string;
  alt: string;
}

export interface MediaRef {
  type: 'audio' | 'video';
  url: string;
  name?: string;
  /** 从正文 HTML 直接抽到的签名直链（mp4/mp3），优先于 url */
  direct?: string;
}

export interface ConvertResult {
  markdown: string;
  images: ImageRef[];
  media: MediaRef[];
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&middot;': '·',
  '&times;': '×',
};

export function decodeEntities(s: string): string {
  let out = s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
  out = out.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}

/** 抽取指定 id 的 div 内部 HTML（按 div 深度平衡，不依赖 DOM） */
export function extractById(html: string, id = 'js_content'): string {
  const open = new RegExp(`<div[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return '';
  const start = m.index + m[0].length;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 1;
  let tm: RegExpExecArray | null;
  while ((tm = tag.exec(html))) {
    depth += tm[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tm.index);
  }
  return html.slice(start);
}

/** 去掉 script/style/注释与内联事件 */
function stripJunk(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function inlineToMd(s: string): string {
  let t = s;
  t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `**${inner.trim()}**`);
  t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `*${inner.trim()}*`);
  t = t.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => '`' + c.trim() + '`');
  t = t.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
    const label = txt.replace(/<[^>]+>/g, '').trim();
    return label ? `[${label}](${href})` : href;
  });
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  return decodeEntities(t);
}

/** 微信 HTML 的多层转义（\x26amp; / &amp; / \x22） */
function unescapeWechat(s: string): string {
  return s
    .replace(/\\x26amp;/g, '&')
    .replace(/\\x26/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\x22/g, '"')
    .replace(/\\x3c/gi, '<')
    .replace(/\\x3e/gi, '>')
    .replace(/\\\//g, '/');
}

/**
 * 从正文 HTML 的 JS 数据块抽「vid → 最大码率 mp4 直链」。
 * 实测 2026-10：每视频 4 档码率（f10002/f10004/f10102…），取 filesize 最大者；
 * 直链带 dis_t 签名，抓取时必须立即下载，过期失效。
 */
export function extractVideoUrls(html: string): Map<string, string> {
  const s = unescapeWechat(html);
  const vids: Array<{ vid: string; idx: number }> = [];
  const vr = /(wxv_\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = vr.exec(s))) vids.push({ vid: m[1], idx: m.index });
  if (!vids.length) return new Map();

  const best = new Map<string, { size: number; url: string }>();
  const ur = /filesize:\s*'(\d+)'[\s\S]{0,400}?url:\s*'([^']*\.mp4[^']*)'/g;
  while ((m = ur.exec(s))) {
    const size = Number(m[1]);
    const url = m[2];
    if (!/^https?:/.test(url)) continue;
    let owner: string | undefined;
    for (const v of vids) {
      if (v.idx < m.index) owner = v.vid;
      else break;
    }
    if (!owner) continue;
    const cur = best.get(owner);
    if (!cur || size > cur.size) best.set(owner, { size, url });
  }

  const out = new Map<string, string>();
  for (const [vid, v] of best) out.set(vid, v.url);
  return out;
}

export function htmlToMarkdown(html: string): ConvertResult {
  const body = extractById(stripJunk(html));
  if (!body) return { markdown: '', images: [], media: [] };

  const images: ImageRef[] = [];
  const media: MediaRef[] = [];
  let text = body;

  // 图片：data-src 优先（微信懒加载），换成占位标记，稍后上层替换成本地路径
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch =
      /\bdata-src=["']([^"']+)["']/i.exec(tag) || /\bsrc=["']([^"']+)["']/i.exec(tag);
    const altMatch = /\balt=["']([^"']*)["']/i.exec(tag);
    const src = srcMatch ? srcMatch[1] : '';
    const alt = altMatch ? decodeEntities(altMatch[1]) : '';
    if (!src || src.startsWith('data:')) return '';
    const idx = images.push({ src, alt }) - 1;
    return `\n\n@@IMG${idx}@@\n\n`;
  });

  // 音频：微信语音 <mpvoice voice_encode_fileid="…"> 与 <audio src>
  text = text.replace(/<mpvoice\b[^>]*>/gi, (tag) => {
    const id = /\bvoice_encode_fileid=["']([^"']+)["']/i.exec(tag);
    const name = /\bname=["']([^"']*)["']/i.exec(tag);
    if (!id) return '';
    const idx = media.push({
      type: 'audio',
      url: `https://res.wx.qq.com/voice/getvoice?mediaid=${id[1]}`,
      name: name ? decodeEntities(name[1]) : '',
    }) - 1;
    return `\n\n@@MEDIA${idx}@@\n\n`;
  });
  text = text.replace(/<audio\b[\s\S]*?<\/audio>/gi, (block) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(block);
    if (!src) return '';
    const idx = media.push({ type: 'audio', url: src[1] }) - 1;
    return `\n\n@@MEDIA${idx}@@\n\n`;
  });

  // 视频：<video src> 与微信播放器 iframe（优先用正文里的签名 mp4 直链）
  const videoMap = extractVideoUrls(html);
  text = text.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(block);
    if (!src) return '';
    const idx = media.push({ type: 'video', url: src[1] }) - 1;
    return `\n\n@@MEDIA${idx}@@\n\n`;
  });
  text = text.replace(/<iframe\b[^>]*>/gi, (tag) => {
    const src = /data-src=["']([^"']+)["']/i.exec(tag) || /src=["']([^"']+)["']/i.exec(tag);
    const vid = /data-mpvid=["']([^"']+)["']/i.exec(tag)?.[1] || /[?&]vid=([A-Za-z0-9_-]+)/.exec(tag)?.[1];
    if (!src && !vid) return '';
    const url = src
      ? decodeEntities(src[1])
      : `https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&vid=${vid}`;
    const idx = media.push({ type: 'video', url, name: vid, direct: vid ? videoMap.get(vid) : undefined }) - 1;
    return `\n\n@@MEDIA${idx}@@\n\n`;
  });

  // 代码块（pre 里可能含 code 与 <br>）
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.replace(/\n{3,}/g, '\n\n').trim()}\n\`\`\`\n\n`;
  });

  // 块级
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv, inner) => {
    return `\n\n${'#'.repeat(Number(lv))} ${inlineToMd(inner).trim()}\n\n`;
  });
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const lines = inlineToMd(inner).trim().split('\n').filter((l) => l.trim());
    return `\n\n${lines.map((l) => '> ' + l.trim()).join('\n')}\n\n`;
  });
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
    const t = inlineToMd(inner).trim().replace(/\s*\n\s*/g, ' ');
    return `\n- ${t}\n`;
  });
  text = text.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner) => `\n\n${inlineToMd(inner).trim()}\n\n`);
  text = text.replace(/<\/?(div|section|article|figure|figcaption|tbody|tr|td)\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  // 清理
  const markdown = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, images, media };
}

/** 把 Markdown 里的 @@IMGn@@ 占位替换成给定路径（含空格/中文时用尖括号包裹） */
export function replaceImagePlaceholders(markdown: string, paths: string[]): string {
  return markdown.replace(/@@IMG(\d+)@@/g, (_m, i) => {
    const p = paths[Number(i)];
    return p ? `![](<${p}>)` : '';
  });
}

/** 媒体占位 @@MEDIA n@@ → HTML 播放器（Obsidian 阅读视图原生支持 audio/video 标签） */
export function replaceMediaPlaceholders(
  markdown: string,
  refs: Array<{ type: 'audio' | 'video'; path?: string; url: string; name?: string }>,
): string {
  return markdown.replace(/@@MEDIA(\d+)@@/g, (_m, i) => {
    const r = refs[Number(i)];
    if (!r) return '';
    if (r.path) {
      return r.type === 'audio'
        ? `<audio controls src="${r.path}"></audio>`
        : `<video controls src="${r.path}"></video>`;
    }
    // 解析不到直链时降级为可点击的原站链接
    return `[${r.type === 'audio' ? '🎧 音频' : '🎬 视频'}：${r.name || '播放'}](<${r.url}>)`;
  });
}

/** 由标题生成安全文件名 */
export function safeFileName(title: string, max = 80): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || '未命名').slice(0, max);
}
