// Cubism Core 6.x 兼容补丁：untitled-pixi-live2d-engine@1.4 的渲染器仍按 Core 5 的
// `model.drawables.renderOrders` 属性读绘制顺序，而 Core 6 把它改成了 `model.getRenderOrders()`。
// 不补的结果：任何模型都画不出来，报 `Cannot read properties of undefined (reading '0')`
// 于 cubism.es.js 的 doDrawModel（renderOrder 为 undefined）。
//
// 幂等：已打过就跳过。npm i 之后要重跑（postinstall 里已经挂了）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  'node_modules/untitled-pixi-live2d-engine/dist/cubism.es.js',
  'node_modules/untitled-pixi-live2d-engine/dist/cubism.js',
]

const OLD = `  getDrawableRenderOrders() {
    const renderOrders = this._model.drawables.renderOrders;
    return renderOrders;`
const NEW = `  getDrawableRenderOrders() {
    const d = this._model.drawables;
    if (d.renderOrders) return d.renderOrders;
    if (typeof this._model.getRenderOrders === 'function') return this._model.getRenderOrders();
    const n = this._model.getDrawableCount();
    const idx = new Float32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return idx;`

let touched = 0
for (const rel of FILES) {
  const file = resolve(ROOT, rel)
  if (!existsSync(file)) continue
  const src = readFileSync(file, 'utf8')
  if (src.includes('if (d.renderOrders) return d.renderOrders;')) continue
  if (!src.includes(OLD)) {
    console.warn('[patch-core6] 未匹配到补丁位置，跳过：' + rel)
    continue
  }
  writeFileSync(file, src.replace(OLD, NEW))
  touched++
  console.log('[patch-core6] 已补：' + rel)
}
console.log(touched ? `[patch-core6] 完成 ${touched} 个文件` : '[patch-core6] 无需修改')
