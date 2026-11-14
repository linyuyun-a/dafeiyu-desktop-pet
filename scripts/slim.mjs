// slim.mjs — 打包后的瘦身（只动 dist 产物，不动仓库）。
//
// 一块块砍，砍完打印省了多少：
//   1. pixi.js  80 MB → 2.2 MB：只保留 dist/pixi.mjs（单文件 ESM，无动态 import），
//      删掉 lib/ src/ 的 .d.ts、sourcemap、以及 pixi.js / pixi.min.js 两个 UMD 版本。
//      我们页面里是 `/vendor8/pixi.js/dist/pixi.mjs` 直接加载这一个文件。
//   2. locales  41 MB → ~2 MB：只留 en-US 与 zh-CN 两个 .pak，其余 53 个语言包删掉。
//   3. 顺手删掉 *.map / *.d.ts / package-lock（运行时用不到，搜索起来还碍事）。
//
// 用法：
//   npm run slim                       # 默认处理 dist 下的构建
//   npm run slim -- "D:\大肥鱼桌宠"     # 处理指定目录（比如手工同步过去的那份）
import { rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function dirSize(dir) {
  let bytes = 0
  const walk = async (d) => {
    let list = []
    try { list = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { try { bytes += (await stat(p)).size } catch {} }
    }
  }
  await walk(dir)
  return bytes
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB'

/** 找到要处理的「应用目录」（含 resources/app 的那一层） */
async function resolveTargets(arg) {
  const out = []
  if (arg) {
    const p = path.resolve(arg)
    out.push(existsSync(path.join(p, 'resources', 'app')) ? p : path.join(p))
    return out.filter((p) => existsSync(path.join(p, 'resources', 'app')))
  }
  const dist = path.join(ROOT, 'dist')
  if (!existsSync(dist)) return out
  for (const e of await readdir(dist, { withFileTypes: true })) {
    const p = path.join(dist, e.name)
    if (e.isDirectory() && existsSync(path.join(p, 'resources', 'app'))) out.push(p)
  }
  return out
}

export async function slimApp(appRoot) {
  const total0 = await dirSize(appRoot)
  console.log(`\n[slim] ${appRoot}  当前 ${mb(total0)}`)

  // 1) pixi.js：只留 dist/pixi.mjs
  const pixi = path.join(appRoot, 'resources', 'app', 'node_modules', 'pixi.js')
  if (existsSync(pixi)) {
    const before = await dirSize(pixi)
    const keepDir = path.join(pixi, 'dist')
    await rm(path.join(pixi, 'lib'), { recursive: true, force: true })
    await rm(path.join(pixi, 'src'), { recursive: true, force: true })
    // 只留 dist/pixi.mjs：UMD 版、webworker 分块、min 版、sourcemap 全删
    for (const f of await readdir(keepDir)) {
      if (f !== 'pixi.mjs') await rm(path.join(keepDir, f), { recursive: true, force: true })
    }
    // transcoders / skills 是文档与工具数据，运行时不读
    await rm(path.join(pixi, 'transcoders'), { recursive: true, force: true })
    await rm(path.join(pixi, 'skills'), { recursive: true, force: true })
    const after = await dirSize(pixi)
    console.log(`   pixi.js        ${mb(before)} → ${mb(after)}`)
  }

  // 2) locales：只留 en-US / zh-CN
  const locales = path.join(appRoot, 'locales')
  if (existsSync(locales)) {
    const before = await dirSize(locales)
    const keep = new Set(['en-US.pak', 'zh-CN.pak'])
    for (const f of await readdir(locales)) {
      if (!keep.has(f)) await rm(path.join(locales, f), { force: true })
    }
    const after = await dirSize(locales)
    console.log(`   locales        ${mb(before)} → ${mb(after)}`)
  }

  // 3) 地图与类型声明
  const nm = path.join(appRoot, 'resources', 'app', 'node_modules')
  let pruned = 0
  const walk = async (d) => {
    let list = []
    try { list = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (e.name.endsWith('.map') || e.name.endsWith('.d.ts')) {
        try { pruned += (await stat(p)).size; await rm(p, { force: true }) } catch {}
      }
    }
  }
  if (existsSync(nm)) await walk(nm)
  if (pruned) console.log(`   *.map/*.d.ts   省 ${mb(pruned)}`)

  const total1 = await dirSize(appRoot)
  console.log(`[slim] 合计 ${mb(total0)} → ${mb(total1)}（省 ${mb(total0 - total1)}）`)
}

// 只有直接运行时才走 CLI；被 pack.mjs import 时只导出 slimApp
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = await resolveTargets(process.argv[2])
  if (!targets.length) {
    console.error('[slim] 没找到可处理的构建目录（先 npm run pack，或用参数指定）')
    process.exit(1)
  }
  for (const t of targets) await slimApp(t)
}
