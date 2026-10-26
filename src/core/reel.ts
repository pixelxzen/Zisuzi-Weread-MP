/**
 * 序列帧文章 → 自播 reel + 页面级静帧（纯函数，无 DOM，可单测）
 *
 * 实测背景（2026-10-26，《谁把秋天煮开了》E2.COOL 位图切片，195 张）：
 *   · 195 张里只有 158–160 个字节唯一的画面，其余全是「停顿」（同一画面重复导出）
 *   · 相邻帧灰度差中位数 0.09/255 —— 大量帧肉眼无差别
 *   · 8×8 dHash 对这套排版（大面积米白留白）分辨率不够：阈值 30 会把
 *     「这一篇，留给桂花」「北京·留」整段文字页吞进插画簇
 *     → 改用 32×32 灰度 sig + 平均绝对差（MAD），文字页与插画页能分开
 *
 * 两个消费者要的东西不一样，所以用同一份签名、两档阈值：
 *   reel（动效）：MAD 收紧保运动；长序列段等间隔抽样，别把 72 帧蒸汽压成 1 帧
 *   stills（读字）：MAD 放宽到页面级，再按停留权重筛掉一闪而过的过渡态
 */

export interface FrameSig {
  /** 32×32 灰度，长度 1024，值域 0–255 */
  sig: number[];
  /** 字节指纹（只用来判「字节完全相同」= 真停顿） */
  bytes: string;
}

export interface ReelFrame {
  /** 原始切片下标（0 基） */
  index: number;
  /** 停留权重（相对时长单位） */
  weight: number;
}

export interface PlanOpts {
  /** reel 用的 MAD 阈值（默认 0.01，收紧以保运动） */
  motionThreshold?: number;
  /** 静帧用的 MAD 阈值（默认 0.05，放宽到页面级） */
  stillsThreshold?: number;
  /** 长序列段内每多少原帧抽 1 帧（默认 8） */
  sampleEvery?: number;
  /** 静帧最小停留权重，低于此值的簇（一闪而过的过渡态）不出图（默认 2） */
  stillsMinWeight?: number;
}

export interface ReelPlan {
  /** reel 帧序列 */
  frames: ReelFrame[];
  /** 页面级静帧（按停留权重筛选后） */
  stills: ReelFrame[];
  /** 原始切片数 */
  slices: number;
  /** 字节唯一画面数 */
  poses: number;
  /** reel 总权重 */
  totalWeight: number;
  /** reel 的视觉簇数 */
  motionClusters: number;
  /** 静帧的视觉簇数（筛选前） */
  stillsClusters: number;
}

/** 两帧 32×32 灰度签名的平均绝对差（0–1） */
export function mad(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n / 255;
}

interface Pose {
  index: number;
  weight: number;
}

/** 把连续字节相同的切片折成一个 pose（权重 = 串长）—— 这就是「停顿」 */
function toPoses(sigs: FrameSig[]): Pose[] {
  const out: Pose[] = [];
  let i = 0;
  while (i < sigs.length) {
    let j = i;
    while (j + 1 < sigs.length && sigs[j + 1].bytes === sigs[i].bytes) j++;
    out.push({ index: i, weight: j - i + 1 });
    i = j + 1;
  }
  return out;
}

/** 按「与簇首比」聚类；锚点必须是簇首，否则逐帧漂移会把整段吞成一簇 */
function clusterByMad(sigs: FrameSig[], poses: Pose[], threshold: number): Pose[][] {
  const groups: Pose[][] = [[poses[0]]];
  for (let k = 1; k < poses.length; k++) {
    const head = groups[groups.length - 1][0];
    if (mad(sigs[poses[k].index].sig, sigs[head.index].sig) > threshold) groups.push([poses[k]]);
    else groups[groups.length - 1].push(poses[k]);
  }
  return groups;
}

export function planReel(sigs: FrameSig[], opts: PlanOpts = {}): ReelPlan {
  const motionThreshold = opts.motionThreshold ?? 0.01;
  const stillsThreshold = opts.stillsThreshold ?? 0.05;
  const sampleEvery = Math.max(1, Math.round(opts.sampleEvery ?? 8));
  const stillsMinWeight = Math.max(1, Math.round(opts.stillsMinWeight ?? 2));
  if (!sigs.length) {
    return { frames: [], stills: [], slices: 0, poses: 0, totalWeight: 0, motionClusters: 0, stillsClusters: 0 };
  }

  const poses = toPoses(sigs);

  // --- reel：紧阈值保运动 ---
  const motionGroups = clusterByMad(sigs, poses, motionThreshold);
  const frames: ReelFrame[] = [];
  for (const g of motionGroups) {
    if (g.length === 1) {
      frames.push({ index: g[0].index, weight: g[0].weight });
      continue;
    }
    // 长序列段：等间隔抽 k 帧，权重按段内总停留均摊（别把运动压成一帧）
    const totalW = g.reduce((s, p) => s + p.weight, 0);
    const k = Math.max(2, Math.ceil(g.length / sampleEvery));
    const per = Math.max(1, Math.round(totalW / k));
    for (let j = 0; j < k; j++) {
      const at = j === k - 1 ? g.length - 1 : Math.min(g.length - 1, Math.round((j + 1) * (g.length / k)) - 1);
      const idx = g[at].index;
      if (frames.length && frames[frames.length - 1].index === idx) continue;
      frames.push({ index: idx, weight: per });
    }
  }

  // --- stills：宽阈值到页面级 + 停留权重筛选 ---
  const stillGroups = clusterByMad(sigs, poses, stillsThreshold);
  const stills: ReelFrame[] = [];
  for (const g of stillGroups) {
    const totalW = g.reduce((s, p) => s + p.weight, 0);
    if (totalW < stillsMinWeight) continue;
    // 代表 = 簇内停得最久的那一帧（最稳定、最适合读字）
    let best = g[0];
    for (const p of g) if (p.weight > best.weight) best = p;
    stills.push({ index: best.index, weight: totalW });
  }

  return {
    frames,
    stills,
    slices: sigs.length,
    poses: poses.length,
    totalWeight: frames.reduce((s, f) => s + f.weight, 0),
    motionClusters: motionGroups.length,
    stillsClusters: stillGroups.length,
  };
}

export interface ReelImage {
  /** data URI（含 data:image/webp;base64, 前缀） */
  dataUri: string;
  weight: number;
}

export interface SvgOpts {
  width: number;
  height: number;
  /** 每权重单位对应多少毫秒 */
  slotMs: number;
  bg?: string;
  /** 循环之间的停顿（毫秒） */
  gapMs?: number;
}

/** 组装自播 SVG（SMIL discrete 台阶动画，自包含：0 脚本 / 0 外链） */
export function buildReelSvg(images: ReelImage[], opts: SvgOpts): string {
  const { width: W, height: H, slotMs } = opts;
  const bg = opts.bg ?? '#f7f4ec';
  const gapMs = Math.max(0, opts.gapMs ?? 0);
  const N = images.length;
  if (!N) return '';
  const totalMs = images.reduce((s, im) => s + im.weight * slotMs, 0) + gapMs;
  const dur = (totalMs / 1000).toFixed(3);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);

  let acc = 0;
  const marks: Array<[number, number]> = [];
  for (const im of images) {
    const t0 = acc / totalMs;
    acc += im.weight * slotMs;
    marks.push([t0, acc / totalMs]);
  }

  images.forEach((im, i) => {
    const [t0, t1] = marks[i];
    let values: string;
    let keyTimes: string;
    if (i === 0) {
      values = '1;0';
      keyTimes = `0;${t1.toFixed(6)}`;
    } else if (i === N - 1) {
      values = '0;1';
      keyTimes = `0;${t0.toFixed(6)}`;
    } else {
      values = '0;1;0';
      keyTimes = `0;${t0.toFixed(6)};${t1.toFixed(6)}`;
    }
    out.push(
      `<image x="0" y="0" width="${W}" height="${H}" opacity="${i === 0 ? 1 : 0}" ` +
        `preserveAspectRatio="xMidYMid meet" href="${im.dataUri}">` +
        `<animate attributeName="opacity" calcMode="discrete" dur="${dur}s" ` +
        `repeatCount="indefinite" values="${values}" keyTimes="${keyTimes}"/>` +
        `</image>`,
    );
  });
  out.push('</svg>');
  return out.join('');
}
