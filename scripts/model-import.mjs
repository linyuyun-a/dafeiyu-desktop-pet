#!/usr/bin/env node
/**
 * 把你自己电脑上的 Live2D 模型复制进 assets/model/（只在本机，不进 git）。
 *
 *   npm run model:import -- "D:/Desktop/DeepSeek免费公皮/DeepSeek"
 *
 * 为什么要有这个脚本：
 *   皮套的《使用须知》禁止重新分发模型文件，所以仓库里不放 .moc3 / 纹理。
 *   这个脚本只做「复制到本地目录」，assets/model/ 在 .gitignore 里，永远不会被提交。
 *
 * 只挑运行时要用的东西（作者给的工程目录里常混着 VBridger / Cocos / 预览截图，不搬）。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEST = process.env.MODEL_DEST ? path.resolve(process.env.MODEL_DEST) : path.join(ROOT, 'assets', 'model')

/** 作者工程里常混着的「不是运行时」的东西：预览图、VBridger 配置、VTuber 配置、说明文档 */
const JUNK_FILE = /(\.vbridger|\.png|\.jpg|\.jpeg|\.webp|\.gif|\.psd|\.txt|\.md|\.zip|\.vtube\.json)$/i
const JUNK_NAME = new Set(['items_pinned_to_model.json', '.DS_Store', 'Thumbs.db'])
const JUNK_DIR = new Set(['.git', '__MACOSX', 'node_modules', '.idea', '.vscode'])

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const src = args[0]

if (!src) {
  console.error(`
用法：
  npm run model:import -- "包含 model3.json 的目录"

例：
  npm run model:import -- "D:/Desktop/DeepSeek免费公皮/DeepSeek"

只往本机 assets/model/ 复制，不进 git（皮套不允许重新分发）。
`)
  process.exit(1)
}

const abs = path.resolve(src)
try {
  const info = await stat(abs)
  if (!info.isDirectory()) throw new Error('not a dir')
} catch {
  console.error(`[model] 找不到目录：${abs}`)
  process.exit(1)
}

/** 在目录（含两层子目录）里找 *.model3.json */
async function findModel(dir, depth = 0) {
  const list = await readdir(dir, { withFileTypes: true })
  const here = list.find((d) => d.isFile() && (d.name === 'model3.json' || d.name.endsWith('.model3.json')))
  if (here) return { file: here.name, base: dir }
  if (depth >= 2) return null
  for (const d of list) {
    if (!d.isDirectory()) continue
    try {
      const hit = await findModel(path.join(dir, d.name), depth + 1)
      if (hit) return hit
    } catch {
      /* 读不了的子目录跳过 */
    }
  }
  return null
}

const hit = await findModel(abs)
if (!hit) {
  console.error(`[model] 这个目录里没有 model3.json / *.model3.json：\n  ${abs}`)
  process.exit(1)
}

const entries = await readdir(hit.base, { withFileTypes: true })
// 除了垃圾，其余都算模型的一部分（纹理目录可能叫 xxx.4096，动作可能在 Animation/ 里）
const picked = entries.filter((d) => {
  if (d.isDirectory()) return !JUNK_DIR.has(d.name)
  return !JUNK_FILE.test(d.name) && !JUNK_NAME.has(d.name)
})

if (!picked.length) {
  console.error('[model] 没找到可导入的模型文件（model3.json / moc3 / textures …）')
  process.exit(1)
}

await mkdir(DEST, { recursive: true })
let n = 0
for (const d of picked) {
  await cp(path.join(hit.base, d.name), path.join(DEST, d.name), { recursive: true, force: true })
  n += 1
}

const total = (await readdir(DEST, { recursive: true })).length
console.log(`[model] 导入 ${n} 项（目录内共 ${total} 个文件）`)
console.log(`[model] 来源 ${hit.base}`)
console.log(`[model] 目标 ${DEST}`)
console.log(`[model] 入口 ${path.join(DEST, hit.file)}`)
// 作者的工程目录常把动作/表情分开放（Animation/、Exp3/），model3.json 里可能是空的；
// 桌面宠物要用到它们，所以这里检查一下并提醒。
try {
  const { readFile } = await import('node:fs/promises')
  const mj = JSON.parse(await readFile(path.join(DEST, hit.file), 'utf8'))
  const fr = mj.FileReferences || {}
  const nExp = (fr.Expressions || []).length
  const nMotions = Object.values(fr.Motions || {}).reduce((a, b) => a + b.length, 0)
  if (!nExp || !nMotions) {
    console.log('')
    console.log(`[model] 注意：这个 model3.json 里只有 ${nExp} 个表情、${nMotions} 个动作引用。`)
    console.log('        作者可能把 Animation/ Exp3/ 单独放；桌宠的表情动作会少一截。')
    console.log('        需要的话可以让我加一步「把 Exp3/*.exp3.json 与 Animation/*.motion3.json 合并进 model3.json」。')
  }
} catch {
  /* 读不到就不提醒 */
}

console.log('')
console.log('提示：assets/model/ 在 .gitignore 里，不会被提交（皮套不允许重新分发）。')
console.log(`     启动：npm run app -- --model "${path.join(DEST, hit.file)}"`)
