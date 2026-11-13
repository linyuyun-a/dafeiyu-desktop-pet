/**
 * 把上游 JIZURA 的引擎（MIT）拼成一份可直接 <script> 引入的包。
 *
 * 只搬「算分镜 + 画一帧」需要的模块，不搬编辑器 UI（12_ui.js）与导出（11_export.js），
 * 也不搬 11p_x2_* 那批「追加分2」（体积 1.5MB，等真要更多表现再开）。
 *
 *   node scripts/build-jizura.mjs            # 生成 app/jizura-engine.js
 *   node scripts/build-jizura.mjs --check    # 只报告体积，不写文件
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(ROOT, '_probe/refs/jizura/src')
const OUT = path.join(ROOT, 'app/jizura-engine.js')

/** 顺序即依赖顺序：上游用 IIFE 往全局 J 上挂东西，先有 J 才能挂。 */
const FILES = [
  '01_util.js',
  '02_fonts.js',
  '02b_lang.js',
  '03_text.js',
  '04_styles.js',
  '05_anim.js',
  '05b_registry.js',
  '06_layouts.js',
  '07_decor.js',
  '08_planner.js',
  '08b_omakase.js',
  '09_render.js',
  '10_audio.js',   // 只需要 J.analyzeAudio（BPM/能量），UI 侧的重活不搬
  '11q_sets.js',
  '11p_styles.js',
  '11p_looks.js',
  '11p_layoutsA.js',
  '11p_enter.js',
  '11p_exit.js',
  '11p_decor.js',
  '11p_bgcamB.js',
  '11p_treattrans.js',
  '11p_typo1.js',
  '11p_typo2.js',
  '11p_typo3.js',
  '11p_kinetic1.js',
  '11p_kinetic2.js',
  '11p_kinetic3.js',
]

const check = process.argv.includes('--check')
const kb = (n) => `${(n / 1024).toFixed(1)}K`

let sha = ''
try {
  sha = execFileSync('git', ['-C', path.join(ROOT, '_probe/refs/jizura'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  sha = 'unknown'
}

const parts = []
let total = 0
for (const f of FILES) {
  const p = path.join(SRC, f)
  const code = readFileSync(p, 'utf8')
  const n = statSync(p).size
  total += n
  parts.push(`/* ---- ${f} (${kb(n)}) ---- */\n${code}`)
  console.log(`${kb(n).padStart(9)}  ${f}`)
}

const banner = `/*!
 * JIZURA engine — trimmed bundle for the 大肥鱼 player window
 * upstream: https://github.com/852wa/JIZURA @ ${sha}
 * license: MIT (see docs/设计-歌词PV.md §8)
 * 只含 planner + renderer + 6 个表现包；不含编辑器 UI / 导出 / 11p_x2_*
 * 由 scripts/build-jizura.mjs 生成，请勿手改。
 */
`
const bundle = `${banner}(function () {\n'use strict'\n${parts.join('\n')}\n})();\n`

console.log(`\nsource total ${(total / 1024 / 1024).toFixed(2)}M → bundle ${(Buffer.byteLength(bundle) / 1024 / 1024).toFixed(2)}M`)
if (check) process.exit(0)

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, bundle)
const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 16)
console.log(`wrote ${path.relative(ROOT, OUT)}  sha256:${digest}…`)
