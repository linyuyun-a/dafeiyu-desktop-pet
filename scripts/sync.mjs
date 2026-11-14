// sync.mjs — 把仓库里的运行时代码同步到「已打包的应用目录」。
//
// 为什么要它：改完 app/*.mjs 后，打包版用的还是 resources/app/ 里的旧拷贝，
// 手工 cp -r 容易漏文件、也容易把 _data / assets/model 覆盖掉。这里只拷运行时需要的：
//
//   app/                       → <目标>/resources/app/app/
//   vendor/live2dcubismcore.min.js → <目标>/resources/app/vendor/
//   package.json               → <目标>/resources/app/package.json
//
// 不碰：assets/（模型与 Core 由打包步骤决定）、_data/（用户数据）、node_modules/。
//
// 用法：
//   npm run sync                       # 默认目标 D:\大肥鱼桌宠
//   npm run sync -- "D:\别的构建目录"
//   STAGE_APP_DEST="D:\x" npm run sync
import { cp, stat, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DEST = 'D:\\大肥鱼桌宠'
const DEST = path.resolve(process.argv[2] || process.env.STAGE_APP_DEST || DEFAULT_DEST)
const APP_DIR = path.join(DEST, 'resources', 'app')

const log = (...a) => console.log('[sync]', ...a)

async function dirSummary(dir) {
  let files = 0
  let bytes = 0
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { files += 1; bytes += (await stat(p)).size }
    }
  }
  if (existsSync(dir)) await walk(dir)
  return { files, bytes }
}

if (!existsSync(APP_DIR)) {
  console.error(`[sync] 找不到 ${APP_DIR}`)
  console.error('       先跑一次 npm run pack，或用参数指定构建目录：npm run sync -- "D:\\某目录"')
  process.exit(1)
}

// 1) 代码
const srcApp = path.join(ROOT, 'app')
const dstApp = path.join(APP_DIR, 'app')
await cp(srcApp, dstApp, { recursive: true, force: true })
log('app/ →', path.relative(DEST, dstApp))

// 2) Cubism Core（专有二进制，仓库里没有，但打包目录里要有）
const coreSrc = path.join(ROOT, 'vendor', 'live2dcubismcore.min.js')
if (existsSync(coreSrc)) {
  const dstVendor = path.join(APP_DIR, 'vendor')
  await mkdir(dstVendor, { recursive: true })
  await cp(coreSrc, path.join(dstVendor, 'live2dcubismcore.min.js'))
  log('vendor/live2dcubismcore.min.js →', path.relative(DEST, dstVendor))
} else {
  log('跳过 Core：仓库里没有 vendor/live2dcubismcore.min.js（先 npm run core）')
}

// 3) package.json（Electron 用它找 main 与版本号）
await cp(path.join(ROOT, 'package.json'), path.join(APP_DIR, 'package.json'))
log('package.json →', path.relative(DEST, APP_DIR))

const after = await dirSummary(dstApp)
log(`完成：${after.files} 个文件，${(after.bytes / 1024 / 1024).toFixed(1)} MB`)
log('如果应用正开着，重启后生效。')
