/**
 * patch-engine.mjs — 给 easy-live2d 打一处最小补丁（幂等）。
 *
 * 背景：Cubism 的裁剪遮罩（clipping mask）默认只用 1 张 render texture，
 * 单次最多容纳 36 个 mask。大肥鱼有 49 个，超出后引擎每帧打印
 *   [CSM][E] not supported mask count : 13
 *   [Details] render texture count : 1, mask count : 49
 * 并把溢出的 mask 塞进错误位置 → 相关网格的遮罩会算错。
 *
 * 官方 SDK 的做法是让调用方传 maskBufferCount：
 *   CubismUserModel.createRenderer(width, height, maskBufferCount = 1)
 *   CubismRenderer_WebGL.initialize(model, maskBufferCount = 1)
 * 但 easy-live2d 内部写死默认值、没有暴露配置项，所以在这里把那一行改成 2。
 * 2 张 render texture → 上限 64 个 mask，够用，额外开销仅 2×256KB 纹理。
 *
 * 为什么不用 patch-package：只改一行字符串，脚本 10 行就够，且升级引擎时
 * 目标字符串若变了会明确报错而不是静默失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules', 'easy-live2d', 'dist', 'index.js');

const FROM = 'this.createRenderer(gl.drawingBufferWidth, gl.drawingBufferHeight);';
const TO = 'this.createRenderer(gl.drawingBufferWidth, gl.drawingBufferHeight, 2);';

if (!fs.existsSync(DIST)) {
  console.error(`✗ 找不到 ${DIST}，先跑 npm install`);
  process.exit(1);
}

const src = fs.readFileSync(DIST, 'utf8');

if (src.includes(TO)) {
  console.log('• easy-live2d 已是 2 张 mask render texture，跳过');
  process.exit(0);
}

const hits = src.split(FROM).length - 1;
if (hits !== 1) {
  console.error(
    `✗ 目标代码出现 ${hits} 次（期望 1 次）。引擎版本可能变了，请重新确认 easy-live2d 的 createRenderer 调用点。`
  );
  process.exit(1);
}

fs.writeFileSync(DIST, src.replace(FROM, TO));
console.log('✓ easy-live2d: maskBufferCount 1 → 2（单次遮罩上限 36 → 64）');
