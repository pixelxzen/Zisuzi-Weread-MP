/**
 * 微信 SVG 交互图文（变体 B：内联 SVG + background-image 位图切片）识别与切片抽取
 *
 * 现象（实测 2026-10-26，《8分钟与17节台阶｜8MIN/17》，1 BOUNDLESS）：
 *   #js_content 里 `<text>` 为 0、`<p>` 为 0、`<img>` 为 0，正文文字被烘焙成
 *   整屏 PNG/GIF，用 CSS `background-image` 贴在每屏一个的内联 <svg> 上。
 *   → htmlToMarkdown() 返回全空，旧逻辑会掉进「小绿书」分支只存摘要+封面。
 *
 * 与变体 A（外部 `wx_fmt=svg` 单个超高 SVG，见 save-article-to-obsidian）的区别：
 *   变体 A 有 `<text>` 可还原；变体 B 的文字是像素，只能 OCR 或整图保留。
 *
 * 本模块只做「识别 + 按文档顺序抽切片」，不做 OCR。
 * 依赖：无（不引 DOM，可单测）。
 */

export interface SvgSlice {
  /** 远端图片地址（mmbiz.qpic.cn，带 ?wx_fmt=） */
  src: string;
  /** 所属顶层 <svg> 的序号（0 基，按文档顺序） */
  block: number;
  /** 画布 viewBox，如 "0 0 1080 1291" */
  viewBox: string;
  /** E2.COOL 组件 label，如「无限伸缩」「404.tech_svg_E2编辑器_上下浮动」 */
  label: string;
}

export interface SvgBitmapStats {
  /** 找到的顶层 <svg> 数量 */
  svgRoots: number;
  /** SVG 内 <text> 元素数（0 = 文字已位图化） */
  textNodes: number;
  /** 正文 <img> 数（0 = 没有常规图片） */
  imgTags: number;
  /** background-image 出现次数（含重复引用） */
  bgRefs: number;
  /** 去重后的图片数 */
  uniqueImages: number;
  /** GIF 数（通常是封面/轮播，体积大户） */
  gifCount: number;
  /** 编辑器指纹 */
  editor: string;
}

export interface SvgBitmapResult {
  isBitmapArticle: boolean;
  slices: SvgSlice[];
  stats: SvgBitmapStats;
  /**
   * 编辑器附带的「AI 语料学习文本」层（`opacity:0` 的隐形 <text>）。
   * 实测只含引言/摘要（一百多字），不是全文 —— 只能当摘要线索，别当正文。
   */
  corpusText: string;
}

/** 只还原会破坏属性解析的实体，不碰 &lt; / &gt;（避免改动结构） */
function prep(html: string): string {
  return html
    .replace(/\\x26amp;/g, '&')
    .replace(/\\x26/g, '&')
    .replace(/\\x22/g, '"')
    .replace(/\\\//g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 按 depth 找出所有顶层 <svg> 的位置区间（用于整块剔除/切片） */
export function svgRanges(body: string): Array<[number, number]> {
  const re = /<svg\b[^>]*>|<\/svg>/gi;
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const tok = m[0].toLowerCase();
    if (tok.startsWith('<svg')) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push([start, m.index + m[0].length]);
        start = -1;
      }
    }
  }
  if (start >= 0) out.push([start, body.length]);
  return out;
}

/** 按 <svg> 深度找出顶层（最外层）svg 块，按文档顺序返回 */
export function splitTopLevelSvg(body: string): string[] {
  return svgRanges(body).map(([s, e]) => body.slice(s, e));
}

/** 抽一个块里的 background-image URL（保序去重） */
export function extractBgUrls(block: string): string[] {
  const re = /background-image\s*:\s*url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    // 属性值可能是 &quot; 包裹（未走 prep 的调用方），剥掉再判空
    const u = m[1]
      .trim()
      .replace(/^&quot;|&quot;$/g, '')
      .replace(/^&#39;|&#39;$/g, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!u || u.startsWith('data:')) continue;
    if (out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

function attr(block: string, name: string): string {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

/**
 * 抽编辑器附带的「AI 语料学习文本」层（`opacity:0` 的健康 <text>/<tspan>）。
 * 实测只含引言/摘要（约 100–200 字），不是全文；仅当长度 ≥ 40 字才采信。
 */
export function extractCorpusText(body: string): string {
  const parts: string[] = [];
  const re = /<tspan\b[^>]*>([\s\S]*?)<\/tspan>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) parts.push(m[1]);
  if (!parts.length) {
    // 没有 tspan 时退回 <text> 直接文本
    const re2 = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
    while ((m = re2.exec(body))) parts.push(m[1]);
  }
  let t = parts.join(' ').replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  // 太短 = 噪声（装饰性文字），不采信
  return t.length >= 40 ? t : '';
}

/**
 * SVG 之外的「真实正文」长度：把顶层 `<svg>` 块整段剔除，再剥标签数剩下的字。
 * 变体 B 的文字全部活在 SVG 里（含语料层）→ 剔完≈0；正常图文有大量 `<p>` → 几百上千。
 * 这是区分「语料层伪装成正文」的关键判据（单看 markdown 长度会被骗）。
 *
 * 为什么不按 `<text>`/`<tspan>` 剥：SVG 的属性值里含大量引号与 CSS 片段，
 * 只剥文字层会留下属性碎片被当成正文（实测残留 36–158 字，阈值全废）。
 */
export function textOutsideSvg(body: string): number {
  const ranges = svgRanges(body);
  let out = '';
  let cur = 0;
  for (const [s, e] of ranges) {
    out += body.slice(cur, s) + ' ';
    cur = e;
  }
  out += body.slice(cur);
  out = out.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const plain = out.replace(/<[^>]+>/g, ' ');
  return plain.replace(/&nbsp;/g, ' ').replace(/\s+/g, '').length;
}

/**
 * 取文章正文区：从 `id="js_content"` 的起点，截到尾部标记为止。
 *
 * 不用 html2md 的 `extractById`：它按 `<div` 深度平衡，遇到 SVG 里不成对的
 * `</div>`（E2.COOL 的 foreignObject 里就有）会**提前截断**——实测一篇 200+ SVG 的
 * 文章被截成 103 KB（实际约 2.5 MB），结果切片全丢、语料层被误当成正文。
 */
function articleBody(html: string): string {
  const i = html.search(/id=["']js_content["']/i);
  if (i < 0) return html;
  const startTag = html.lastIndexOf('<div', i);
  let seg = html.slice(startTag >= 0 ? startTag : i);
  for (const mk of ['id="js_article_bottom"', 'class="rich_media_tool', 'id="js_slider"', 'id="js_pc_qr_code"']) {
    const j = seg.indexOf(mk);
    if (j > 1000) {
      seg = seg.slice(0, j);
      break;
    }
  }
  return seg;
}

/**
 * 判定 + 抽取。
 * 主判据（全部满足）：
 *   1) 正文 <img> 数为 0（没有常规 data-src 图片）
 *   2) 去重后 background-image ≥ 2（单个 background-image 通常是背景装饰/变体 A 的外链 SVG）
 *   3) 存在编辑器指纹 powered-by="e2.cool"，或顶层 svg ≥ 2
 *   4) SVG 之外的真实正文 < 20 字（**最关键的判据**）
 *
 * ⚠️ 不能用 `<text>` 数当判据：E2.COOL 新版会在 SVG 里塞一层 `opacity:0` 的
 * 「AI 语料学习文本」（约百字），使 textNodes = 1，且 htmlToMarkdown 会把这层当成
 * 正文抽出 295 字 —— 于是调用方的「正文为空」守卫失效，整篇切片全丢（实测踩到）。
 * 用条件 4 判：这类文章的正文其实全在 SVG 里，语料层只是诱饵。
 * 变体 A（外部 wx_fmt=svg 单个超高 SVG）靠「唯一背景图 = 1」被条件 2 挡掉。
 */
export function detectSvgBitmap(html: string): SvgBitmapResult {
  const empty: SvgBitmapResult = {
    isBitmapArticle: false,
    slices: [],
    corpusText: '',
    stats: { svgRoots: 0, textNodes: 0, imgTags: 0, bgRefs: 0, uniqueImages: 0, gifCount: 0, editor: '' },
  };
  if (!html) return empty;

  const src = prep(html);
  let body = articleBody(src);
  // 语料文字要在「剔除语料层」之前抽，否则连它的 <text> 一起被删掉
  const corpusText = extractCorpusText(body);
  // 剔除编辑器塞的「AI 语料学习文本」隐藏层：E2.COOL 会把它渲染成一个
  // `<section label="…AI语料学习文本…">` 里的 `<p><span>`（全角空格排版、视觉隐藏）。
  // 它会被 htmlToMarkdown 当正文抽出来（实测 295 字），让「正文为空」判据全废。
  body = body.replace(/<section\b[^>]*AI语料学习文本[\s\S]*?<\/section>/gi, ' ');
  // 再截到「最后一个顶层 </svg>」之后：微信底部工具栏（在看/分享/留言/小程序引导）
  // 是纯文本且在 SVG 之外，会把「SVG 外正文」判据污染成几十字（实测 36 字）。
  const allRanges = svgRanges(body);
  if (allRanges.length) body = body.slice(0, allRanges[allRanges.length - 1][1]);

  const textNodes = (body.match(/<text\b/gi) || []).length;
  const imgTags = (body.match(/<img\b/gi) || []).length;
  const bgRefs = (body.match(/background-image\s*:/gi) || []).length;
  const editor = /powered-by=["']e2\.cool["']/i.test(body)
    ? 'e2.cool'
    : /powered-by=["']([^"']+)["']/i.exec(body)?.[1] || '';

  const blocks = splitTopLevelSvg(body);
  const slices: SvgSlice[] = [];
  const seen: Record<string, true> = {};
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const urls = extractBgUrls(block);
    if (!urls.length) continue;
    const viewBox = attr(block, 'viewbox') || attr(block, 'viewBox');
    const label = attr(block, 'label');
    for (const u of urls) {
      if (seen[u]) continue;
      seen[u] = true;
      slices.push({ src: u, block: b, viewBox, label });
    }
  }

  const uniqueImages = slices.length;
  const gifCount = slices.filter((s) => /wx_fmt=gif|\.gif(\?|$)/i.test(s.src)).length;

  const stats: SvgBitmapStats = {
    svgRoots: blocks.length,
    textNodes,
    imgTags,
    bgRefs,
    uniqueImages,
    gifCount,
    editor,
  };

  const isBitmapArticle =
    imgTags === 0 &&
    uniqueImages >= 2 &&
    (!!editor || blocks.length >= 2) &&
    textOutsideSvg(body) < 20;

  return {
    isBitmapArticle,
    slices: isBitmapArticle ? slices : [],
    stats,
    corpusText: isBitmapArticle ? corpusText : '',
  };
}

/** 生成笔记正文：按文档顺序的图片占位 + 顶部说明。路径替换交给 replaceImagePlaceholders */
export function buildSvgBitmapMarkdown(result: SvgBitmapResult, imageOffset = 0): string {
  const { stats, slices } = result;
  const lines: string[] = [];
  lines.push('> **这是一篇 SVG 交互图文**（内联 SVG + 位图切片）。');
  lines.push('> 原文把每一屏排版烘焙成整图贴在 SVG 上（无可用文本节点、无 `<img>`），');
  lines.push('> 所以下图**就是原文**，按阅读顺序排列；文字无法作为文本提取，需要时请用 OCR 还原。');
  lines.push('> 点击展开 / 吸附滑动等交互需回原链接体验。');
  lines.push('>');
  lines.push(
    `> 技术指纹：${stats.svgRoots} 个内联 SVG · ${stats.uniqueImages} 张切片${
      stats.gifCount ? `（含 ${stats.gifCount} 个 GIF）` : ''
    } · ${stats.textNodes} 个文本节点（不可读）· ${stats.imgTags} 个 img 标签${
      stats.editor ? ` · 编辑器 ${stats.editor}` : ''
    }`,
  );
  lines.push('');
  if (result.corpusText) {
    lines.push('**编辑器附带的「AI 语料层」文字**（SVG 里 `opacity:0` 的隐形 `<text>`，');
    lines.push('实测只含引言/摘要、不是全文，仅供检索用）：');
    lines.push('');
    lines.push('> ' + result.corpusText);
    lines.push('');
  }
  slices.forEach((s, i) => {
    lines.push(`@@IMG${imageOffset + i}@@`);
    lines.push('');
  });
  return lines.join('\n').trim();
}
