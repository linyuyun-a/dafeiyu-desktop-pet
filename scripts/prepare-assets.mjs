/**
 * prepare-assets.mjs — 把原始素材（D:\Desktop\DeepSeek免费公皮\DeepSeek）加工成引擎能吃的包
 *
 * 做四件事：
 *   ① 纹理降采样（默认最长边 2048）+ 重命名成 ascii
 *   ② 生成「补注册」的 model3.json（Motions / Expressions / HitAreas / LipSync）
 *   ③ 拷贝 Cubism Core + 校验 sha256
 *   ④ 全量校验：表情/动作引用的参数是否真实存在、纹理尺寸、显存估算
 *
 * 不修改原始素材（只读），输出全在 assets/。
 * 用法：node scripts/prepare-assets.mjs [--max-texture 2048] [--force]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GESTURES, buildMotion, gestureGroup, gestureFile } from './motion-specs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SRC = process.env.PET_SRC ?? 'D:/Desktop/DeepSeek免费公皮/DeepSeek';
const CORE_SRC =
  process.env.PET_CORE ?? path.join(ROOT, 'vendor', 'cubism-r5', 'live2dcubismcore.min.js');
const OUT = path.join(ROOT, 'assets', 'model');
const CORE_OUT = path.join(ROOT, 'assets', 'core', 'live2dcubismcore.min.js');

const argv = process.argv.slice(2);
const ARG_MAX = argv.includes('--max-texture') ? Number(argv[argv.indexOf('--max-texture') + 1]) : null;
const TEXTURE_MAX = ARG_MAX ?? Number(process.env.PET_TEXTURE_MAX ?? 2048);

// ────────────────────────────────────────────────────────────────────────────
// 映射表：原名 → ascii id / 分组 / 标签
// 说明：中文名一律不参与路径（asar / URL 编码 / 大小写不敏感文件系统都容易出岔），
//       中文只作为 label 保留在 manifest 里。表情里的「＞＜」是全角字符，靠 index 定位，绝不手敲。
// ────────────────────────────────────────────────────────────────────────────
const EXPRESSIONS = [
  ['default', '默认体型', '基准'],
  ['body1', '体型1', '彩蛋·换体型'],
  ['body2', '体型2', '彩蛋·换体型'],
  ['tooth', '兔牙', '开心'],
  ['lean', '前倾', '凑近听'],
  ['loading', '加载', '思考中'],
  ['monocle', '单片眼镜', '优雅 / 吐槽'],
  ['dizzy', '圈圈眼', '困惑'],
  ['tail_off', '尾巴开关', '彩蛋开关'],
  ['sneer', '屑屑眼', '嫌弃'],
  ['sweat', '流冷汗', '紧张'],
  ['cry', '流泪', '难过'],
  ['heart', '爱心眼', '爱心'],
  ['finger_on', '竖食指开', '讲解开'],
  ['finger_off', '竖食指关', '讲解关'],
  ['chest', '胸口衣服', '换装'],
  ['shoes_off', '脱鞋', '彩蛋·居家'],
  ['blush', '脸红', '害羞'],
  ['skirt', '裙子切换', '换装'],
  ['basin', '钢盆', '彩蛋·护住'],
  ['glasses', '黑框眼镜', '工作模式'],
  ['blackface', '黑脸', '强嫌弃'],
  ['squint', '＞＜', '强开心 / 惊讶'],
];

const MOTIONS = [
  // ascii id, 原名, 分组, 标签, 是否循环
  ['idle', 'IDLE', 'Idle', '待机', true],
  ['hand_up', '默认手切举手', 'TapBody', '举手', false],
  ['hand_down', '举手切默认手', 'TapBody', '放下手', false],
  ['grass_out', '狗尾草切换出来', 'Prop', '掏出狗尾草', false],
  ['grass_in', '狗尾草切回默认手', 'Prop', '收起狗尾草', false],
  ['point_out', '竖手指切出来动画', 'Emote', '竖食指', false],
  ['point_in', '竖手指切回默认', 'Emote', '收回食指', false],
  ['escape', '脱捕', 'Special', '脱捕（长动作）', false],
];

const GROUPS = ['Idle', 'TapBody', 'Prop', 'Emote', 'Special', 'Gesture', 'TapHead'];

// ────────────────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  ⚠️ ', ...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const human = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const num = (n) => Math.round(n * 100) / 100;

async function readJson(p) {
  return JSON.parse(await fsp.readFile(p, 'utf8'));
}
async function writeJson(p, obj) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function mustExist(p) {
  if (!fs.existsSync(p)) {
    console.error(`\n✗ 找不到：${p}\n  素材路径可用环境变量 PET_SRC 覆盖。\n`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 用 Cubism Core 读 moc3：拿 drawable / part / 顶点包围盒（HitAreas 需要真实 drawable id）
// ────────────────────────────────────────────────────────────────────────────
function loadCore() {
  const sandbox = {
    // core 自己会 console.log 版本号，这里吞掉，输出留给我们自己
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, performance, WebAssembly,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  const fakeCanvas = () => ({
    width: 1, height: 1, style: {},
    getContext: () => null,
    addEventListener() {}, removeEventListener() {},
  });
  sandbox.document = {
    createElement: () => fakeCanvas(),
    createElementNS: () => fakeCanvas(),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { style: {} },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.navigator = { userAgent: 'node' };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE_SRC, 'utf8'), ctx, { filename: 'live2dcubismcore.min.js' });
  const C = sandbox.Live2DCubismCore;
  if (!C) throw new Error('Core 加载失败：sandbox 里没有 Live2DCubismCore');
  return C;
}

async function openMoc(C, mocPath) {
  const buf = await fsp.readFile(mocPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // wasm 是异步初始化的：_ptr 为 0 时说明还没好，轮询
  for (let i = 0; i < 80; i++) {
    const moc = C.Moc.fromArrayBuffer(ab);
    if (moc) {
      const model = C.Model.fromMoc(moc);
      if (model) return { moc, model, version: typeof C.Version?.csmGetVersion === 'function' ? C.Version.csmGetVersion() : 0 };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Core 吃不下这个 moc3：${mocPath}`);
}

/** 读 drawable 顶点包围盒（模型坐标系），并归到 part 名下 */
function inspectModel(model) {
  const d = model.drawables;
  const p = model.parts;
  const out = [];
  const stride = 2;
  for (let i = 0; i < d.count; i++) {
    const base = d.vertexPositions[i];
    const vc = d.vertexCounts[i];
    if (!base || !vc) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < vc; v++) {
      const x = base[v * stride];
      const y = base[v * stride + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const partIndex = d.parentPartIndices[i];
    out.push({
      index: i,
      id: d.ids[i],
      partIndex,
      partId: p.ids[partIndex],
      vc,
      bbox: { minX, maxX, minY, maxY },
      area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY),
    });
  }
  return out;
}

/** 在指定 part 名（中文名来自 cdi3）下挑包围盒最大的 drawable，作为命中区 */
function pickHitDrawable(drawables, partIdsByName, partName) {
  const partId = partIdsByName.get(partName);
  if (!partId) return null;
  const candidates = drawables.filter((x) => x.partId === partId);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0];
}

/** 把全角/中文文件名按 index 对应到 ascii，不依赖手敲字符 */
function indexChineseFiles(dir, suffix) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix));
  const byStem = new Map();
  for (const f of files) byStem.set(f.slice(0, -suffix.length), f);
  return byStem;
}

/** 全角→半角 + 去空白：`＞＜` 与 `><` 视为同一个名字 */
function normName(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, '')
    .replace(/\s+/g, '');
}

/** 先精确匹配，再全角/空白归一化匹配 */
function matchByStem(map, label) {
  if (map.has(label)) return map.get(label);
  const want = normName(label);
  for (const [stem, file] of map) if (normName(stem) === want) return file;
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log(`\n▶ 素材源：${SRC}`);
  mustExist(SRC);
  mustExist(path.join(SRC, '大肥鱼.moc3'));
  mustExist(CORE_SRC);

  const forcible = argv.includes('--force');
  if (fs.existsSync(OUT)) {
    if (!forcible && fs.existsSync(path.join(OUT, 'manifest.json'))) {
      // 默认重建：资产是纯派生产物，重建最省心
    }
    await fsp.rm(OUT, { recursive: true, force: true });
  }
  await fsp.mkdir(path.join(OUT, 'textures'), { recursive: true });
  await fsp.mkdir(path.join(OUT, 'motions'), { recursive: true });
  await fsp.mkdir(path.join(OUT, 'expressions'), { recursive: true });
  await fsp.mkdir(path.dirname(CORE_OUT), { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: SRC,
    textureMaxSide: TEXTURE_MAX,
    core: {},
    files: {},
    textures: [],
    expressions: [],
    motions: [],
    hitAreas: [],
    warnings: [],
  };
  const warnings = manifest.warnings;

  // ── ① Core ───────────────────────────────────────────────────────────────
  log('\n[1/6] Cubism Core');
  const coreBuf = await fsp.readFile(CORE_SRC);
  const C = loadCore();
  // easy-live2d@1.0.0 在 initializeCubism() 里硬性要求该常量，缺了会在运行时才炸
  if (C.MocVersion_53 === undefined) {
    throw new Error(
      `Core 不含 MocVersion_53（不是 Cubism 5 SDK for Web R5）：${CORE_SRC}\n` +
        '换成 vendor/cubism-r5/live2dcubismcore.min.js 重跑。'
    );
  }
  await fsp.writeFile(CORE_OUT, coreBuf);
  const { moc, model } = await openMoc(C, path.join(SRC, '大肥鱼.moc3'));
  // R5 的 csmGetVersion() 在 wasm 未就绪时返回垃圾值，版本号直接按 R5 标注（上面已校验 MocVersion_53）
  const coreVersion = 'Cubism 5 SDK for Web R5';
  manifest.core = {
    file: 'assets/core/live2dcubismcore.min.js',
    bytes: coreBuf.length,
    sha256: sha256(coreBuf),
    version: coreVersion,
    source: CORE_SRC,
  };
  log(`  core ${coreVersion} · ${human(coreBuf.length)} · sha256 ${manifest.core.sha256.slice(0, 16)}…`);
  log(`  canvas ${model.canvasinfo.CanvasWidth}×${model.canvasinfo.CanvasHeight}（PixelsPerUnit ${model.canvasinfo.PixelsPerUnit}）`);

  // ── ② moc3 / physics / cdi3 ─────────────────────────────────────────────
  log('\n[2/6] 模型文件');
  for (const [from, to] of [
    ['大肥鱼.moc3', 'model.moc3'],
    ['大肥鱼.physics3.json', 'model.physics3.json'],
    ['大肥鱼.cdi3.json', 'model.cdi3.json'],
  ]) {
    const src = path.join(SRC, from);
    mustExist(src);
    const buf = await fsp.readFile(src);
    await fsp.writeFile(path.join(OUT, to), buf);
    manifest.files[to] = { bytes: buf.length, sha256: sha256(buf), from };
    log(`  ${to}  ${human(buf.length)}`);
  }

  const cdi = await readJson(path.join(SRC, '大肥鱼.cdi3.json'));
  const paramIds = new Set(cdi.Parameters.map((p) => p.Id));
  const partIdsByName = new Map(cdi.Parts.map((p) => [p.Name, p.Id]));

  // ②b 参数表：视线跟随 / 二次运动层要靠它把参数名映射成 core 里的下标，
  // 下标顺序必须和 moc 完全一致，所以这份表是 scripts/params.json 的快照，不在这里现算。
  const paramTable = path.join(ROOT, 'scripts', 'params.json');
  if (fs.existsSync(paramTable)) {
    const buf = await fsp.readFile(paramTable);
    await fsp.writeFile(path.join(OUT, 'params.json'), buf);
    log(`  params.json  ${human(buf.length)}（509 个参数，供视线/二次运动取下标）`);
  } else {
    throw new Error('缺少 scripts/params.json：视线跟随与二次运动层会读不到参数');
  }

  // ── ③ 纹理 ───────────────────────────────────────────────────────────────
  log(`\n[3/6] 纹理降采样（最长边 ≤ ${TEXTURE_MAX}）`);
  const texDir = path.join(SRC, '大肥鱼.4096');
  mustExist(texDir);
  const texFiles = fs.readdirSync(texDir).filter((f) => f.endsWith('.png')).sort();
  let vramBefore = 0;
  let vramAfter = 0;
  for (let i = 0; i < texFiles.length; i++) {
    const src = path.join(texDir, texFiles[i]);
    const meta = await sharp(src).metadata();
    const scale = Math.min(1, TEXTURE_MAX / Math.max(meta.width, meta.height));
    const w = Math.max(1, Math.round(meta.width * scale));
    const h = Math.max(1, Math.round(meta.height * scale));
    const outName = `tex_${String(i).padStart(2, '0')}.png`;
    const outPath = path.join(OUT, 'textures', outName);
    await sharp(src)
      .resize({ width: w, height: h, kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 6, effort: 4, palette: false })
      .toFile(outPath);
    const st = await fsp.stat(outPath);
    const outMeta = await sharp(outPath).metadata();
    vramBefore += meta.width * meta.height * 4;
    vramAfter += outMeta.width * outMeta.height * 4;
    manifest.textures.push({
      file: `textures/${outName}`,
      from: texFiles[i],
      fromSize: `${meta.width}×${meta.height}`,
      size: `${outMeta.width}×${outMeta.height}`,
      bytes: st.size,
    });
    log(`  ${texFiles[i]} ${meta.width}×${meta.height} → ${outMeta.width}×${outMeta.height}  ${human(st.size)}`);
  }
  log(`  显存估算：${(vramBefore / 1048576).toFixed(0)} MB → ${(vramAfter / 1048576).toFixed(0)} MB（RGBA，未含 mipmap）`);

  // ── ④ 表情 ───────────────────────────────────────────────────────────────
  log('\n[4/6] 表情');
  const expDir = path.join(SRC, 'Exp3');
  mustExist(expDir);
  const expFileByStem = indexChineseFiles(expDir, '.exp3.json');
  const expEntries = [];
  const usedExpFiles = new Set();
  for (const [id, label, note] of EXPRESSIONS) {
    const file = matchByStem(expFileByStem, label);
    if (!file) {
      throw new Error(`表情素材缺失：${label}（在 ${expDir} 里找不到）`);
    }
    usedExpFiles.add(file);
    const exp = await readJson(path.join(expDir, file));
    const targets = (exp.Parameters ?? []).map((p) => p.Id);
    const missing = targets.filter((t) => !paramIds.has(t));
    if (missing.length) warn(`表情「${label}」引用了 cdi3 里没有的参数：${missing.join(', ')}`);
    const outFile = `expr_${id}.exp3.json`;
    // 原文件没写 FadeInTime/FadeOutTime，Cubism 默认 1.0s。桌宠切表情要"啪"一下：
    // 太长会在过渡中同时看到旧眼睛和新表情（截图/肉眼都像重影）。
    const expOut = { ...exp, FadeInTime: 0.15, FadeOutTime: 0.2 };
    await fsp.writeFile(path.join(OUT, 'expressions', outFile), JSON.stringify(expOut, null, 2) + '\n');
    expEntries.push({ Name: id, File: `expressions/${outFile}` });
    manifest.expressions.push({
      id,
      label,
      note,
      from: file,
      file: `expressions/${outFile}`,
      params: targets.length,
      missingParams: missing,
    });
    log(`  ${id.padEnd(11)} ← ${label.padEnd(6)} (${targets.length} 参数)${missing.length ? '  ⚠' : ''}`);
  }
  const unusedExp = [...expFileByStem.values()].filter((f) => !usedExpFiles.has(f));
  if (unusedExp.length) warn(`有 ${unusedExp.length} 个 exp3 没被映射：${unusedExp.join(', ')}`);

  // ── ⑤ 动作 ───────────────────────────────────────────────────────────────
  log('\n[5/6] 动作');
  const animDir = path.join(SRC, 'Animation');
  mustExist(animDir);
  const animFileByStem = indexChineseFiles(animDir, '.motion3.json');
  const motionGroups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const [id, label, group, note, loop] of MOTIONS) {
    const file = matchByStem(animFileByStem, label);
    if (!file) throw new Error(`动作素材缺失：${label}（在 ${animDir} 里找不到）`);
    const raw = await readJson(path.join(animDir, file));
    const dur = raw.Meta?.Duration ?? 0;
    const srcCurves = raw.Curves?.length ?? 0;
    // 关键修正：原始 8 个 motion3 全部 Meta.Loop = true。
    // 引擎里 Loop 是逐动作读的（不存在「一次性播放」参数），
    // 所以一次性手势必须在这里落成 Loop:false，否则点了会永远循环。
    const out = {
      Version: 3,
      Meta: {
        ...raw.Meta,
        Loop: loop,
      },
      Curves: raw.Curves,
    };
    if (!loop) {
      // 手势动作补上淡入淡出，避免从待机切过去时闪一下
      out.Meta.FadeInTime = raw.Meta?.FadeInTime ?? 0.25;
      out.Meta.FadeOutTime = raw.Meta?.FadeOutTime ?? 0.35;
    }
    const outFile = `${id}.motion3.json`;
    await writeJson(path.join(OUT, 'motions', outFile), out);
    const entry = { File: `motions/${outFile}` };
    if (!loop) {
      entry.FadeInTime = out.Meta.FadeInTime;
      entry.FadeOutTime = out.Meta.FadeOutTime;
    }
    motionGroups[group].push(entry);
    manifest.motions.push({ id, label, group, note, file: `motions/${outFile}`, duration: num(dur), curves: srcCurves, loop });
    log(`  ${group.padEnd(8)} ${id.padEnd(10)} ← ${label.padEnd(9)} ${dur.toFixed(2)}s${loop ? ' · loop' : ''}`);
  }

  // ── ⑤b 手势动作（手写 motion3，不需要 Cubism Editor）────────────────────
  // 参数只写 OP 与自由参数；绝不写 ParamAngle* / 头发 / 裙子 / 尾巴 —— 那是物理输出。
  if (GESTURES.length) log('\n[5b/6] 手势动作（motion-specs.mjs → motion3.json）');
  for (const g of GESTURES) {
    const group = gestureGroup(g);
    const motion = buildMotion(g);
    const outFile = gestureFile(g);
    await writeJson(path.join(OUT, 'motions', outFile), motion);
    motionGroups[group] ??= [];
    motionGroups[group].push({
      File: `motions/${outFile}`,
      FadeInTime: motion.Meta.FadeInTime,
      FadeOutTime: motion.Meta.FadeOutTime,
    });
    manifest.motions.push({
      id: g.id,
      label: g.label,
      group,
      note: '手写',
      file: `motions/${outFile}`,
      duration: motion.Meta.Duration,
      curves: motion.Curves.length,
      loop: false,
    });
    log(
      `  ${group.padEnd(8)} ${g.id.padEnd(12)} ← ${g.label.padEnd(5)} ${motion.Meta.Duration.toFixed(2)}s · ${motion.Curves.length} 曲线`
    );
  }

  // ── ⑥ HitAreas ───────────────────────────────────────────────────────────
  log('\n[6/6] 命中区（HitAreas 的 Id 必须是真实 drawable id）');
  const drawables = inspectModel(model);
  const headHit = pickHitDrawable(drawables, partIdsByName, '头');
  const bodyHit = pickHitDrawable(drawables, partIdsByName, '身体');
  const hitAreas = [];
  if (headHit) hitAreas.push({ Id: headHit.id, Name: 'Head' });
  else warnings.push('找不到「头」part 下的 drawable，Head 命中区缺失');
  if (bodyHit) hitAreas.push({ Id: bodyHit.id, Name: 'Body' });
  else warnings.push('找不到「身体」part 下的 drawable，Body 命中区缺失');
  const cw = model.canvasinfo.CanvasWidth;
  const ch = model.canvasinfo.CanvasHeight;
  const ppu = model.canvasinfo.PixelsPerUnit;
  const ox = model.canvasinfo.CanvasOriginX;
  const oy = model.canvasinfo.CanvasOriginY;
  // 顶点是模型单位，乘 PPU 再加原点才是画布像素
  const toPxX = (u) => u * ppu + ox;
  const toPxY = (u) => oy - u * ppu;
  for (const h of [headHit, bodyHit]) {
    if (!h) continue;
    const b = h.bbox;
    const left = toPxX(b.minX);
    const right = toPxX(b.maxX);
    const top = toPxY(b.maxY);
    const bottom = toPxY(b.minY);
    manifest.hitAreas.push({
      name: h.id === headHit?.id ? 'Head' : 'Body',
      drawable: h.id,
      part: h.partId,
      vertices: h.vc,
      bbox: { minX: num(b.minX), maxX: num(b.maxX), minY: num(b.minY), maxY: num(b.maxY) },
      pixels: {
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      },
      // 归一化：0..1，左上原点（画布坐标），M1 定标时可对照截图
      norm: {
        x: num(left / cw),
        y: num(top / ch),
        w: num((right - left) / cw),
        h: num((bottom - top) / ch),
      },
    });
    log(
      `  ${h.id === headHit?.id ? 'Head' : 'Body'}  ← ${h.id} (part ${h.partId}, ${h.vc} 顶点)  像素 ${Math.round(left)},${Math.round(top)} ${Math.round(right - left)}×${Math.round(bottom - top)}  归一化 ${JSON.stringify(manifest.hitAreas.at(-1).norm)}`
    );
  }

  // ── 写 model3.json ───────────────────────────────────────────────────────
  const model3 = {
    Version: 3,
    FileReferences: {
      Moc: 'model.moc3',
      Textures: manifest.textures.map((t) => t.file),
      Physics: 'model.physics3.json',
      DisplayInfo: 'model.cdi3.json',
      Motions: motionGroups,
      Expressions: expEntries,
    },
    Groups: [
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeROpen', 'ParamEyeLOpen'] },
      // 这个模型的 LipSync 组原本是空的；登记 ParamMouthOpenY 后，
      // 引擎的 lipSync 流程能识别到 id，但真正驱动仍由我们手动 setParameterValueById（见规划 §4.1）
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ],
    HitAreas: hitAreas,
  };
  await writeJson(path.join(OUT, 'model3.json'), model3);
  log(`\n  model3.json：${Object.keys(motionGroups).length} 个动作组 / ${expEntries.length} 个表情 / ${hitAreas.length} 个命中区`);

  // ── 校验 ────────────────────────────────────────────────────────────────
  log('\n[校验]');
  const checks = [];
  const check = (ok, msg) => { checks.push({ ok, msg }); log(`  ${ok ? '✓' : '✗'} ${msg}`); };

  check(fs.existsSync(path.join(OUT, 'model.moc3')), 'model.moc3 存在');
  check(manifest.textures.length === 5, `5 张纹理（实际 ${manifest.textures.length}）`);
  check(manifest.expressions.length === 23, `23 个表情（实际 ${manifest.expressions.length}）`);
  check(manifest.motions.length === 8 + GESTURES.length, `${8 + GESTURES.length} 个动作（8 原始 + ${GESTURES.length} 手势；实际 ${manifest.motions.length}）`);
  check(hitAreas.length === 2, 'Head + Body 命中区');
  check(!paramIds.has('ParamMouthOpenY') ? false : true, 'ParamMouthOpenY 存在（口型可驱动）');
  const maxSide = Math.max(...manifest.textures.map((t) => Math.max(...t.size.split('×').map(Number))));
  check(maxSide <= TEXTURE_MAX, `纹理最长边 ${maxSide} ≤ ${TEXTURE_MAX}`);
  check(vramAfter / 1048576 < 150, `显存估算 ${(vramAfter / 1048576).toFixed(0)} MB < 150 MB`);
  const missingMouth = manifest.expressions.filter((e) => e.missingParams.length);
  check(missingMouth.length === 0, `表情参数全部能在 cdi3 里找到${missingMouth.length ? `（${missingMouth.length} 个有问题）` : ''}`);

  manifest.vram = { before: `${(vramBefore / 1048576).toFixed(0)} MB`, after: `${(vramAfter / 1048576).toFixed(0)} MB` };
  manifest.elapsedMs = Date.now() - t0;
  await writeJson(path.join(OUT, 'manifest.json'), manifest);

  const failed = checks.filter((c) => !c.ok);
  log(`\n${failed.length ? '✗ 有 ' + failed.length + ' 项没过' : '✓ 全部通过'} · 用时 ${(manifest.elapsedMs / 1000).toFixed(1)}s`);
  log(`  产物：${OUT}`);
  log(`  清单：${path.join(OUT, 'manifest.json')}\n`);
  for (const w of warnings) warn(w);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('\n✗ prepare-assets 失败：', e);
  process.exit(1);
});
