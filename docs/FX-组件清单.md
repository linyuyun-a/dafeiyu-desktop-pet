# FX 组件清单（移植自 fifi-video）

来源：`huiq777/fifi-video`（MIT），`motion/components/explainer/`。
已整套 vendor 到 `app/fx/vendor/fifi/`（37 个文件 + `xm-assets/`，共 15 MB）。
`xm-assets` 里是示例图片/字体等素材，**只有少数组件需要**，不需要的可以整目录删掉。

## 怎么加载

它们是 **classic script + IIFE**，必须按顺序：

```
lib.js → timeline.js → xk.js → xm-core.js → xm-ds.js → 其余 xm-*.js（顺序基本无关）
```

导出的都是**顶层 `const`**（不是 `window.X`），所以引用时写 `XM`、`XK`、`DS`，不能写 `window.XM`。
舞台尺寸固定 `W=1920, H=1080`，绘制时把 1920×1080 缩放铺进目标区域即可。

## 现有能力一览（`XM` 上挂了约 45 个）

### 一、画布特效（最轻，不依赖素材，建议先接）

| 名字 | 说明 |
|---|---|
| `XM.FX` | 14 个滤镜：`halftone barcode bracket star4 cross timecode hud odometer wordRows speedLines ecg glitch rgbSplit zoomBlur`（按名字取，多为 `fx(g, t, o)` 形式） |
| `XM.tex` | 纸纹 / 网格 / 水洗底：`paper grid wash`，`use/begin/end/flush` |
| `XM.doodle` | 毛笔笔触、圈子、箭头（`DS.tone('ink')` 取墨色调色板） |
| `XM.mark` | `sweep lead bracket hiText callout stamp`：扫描线、引线、角括号、文字高亮、标注框、印章 |
| `XM.thirds` | 三分构图辅助线 |
| `XM.scanEye` | 扫描眼 / 取景框 |
| `XM.DS` | 调色盘：`tone('ink'|'paper'|'print'|...)` 返回整套颜色 |

### 二、版式场景（要文字参数，属于「会动的字幕版式」）

`bigType` `bigName` `bigQuote` `titleCard` `trackTitle` `wordCuts` `textCorridor`
`typeSpecimen` `tiltWords` `dayStrip` `numberRoll`

调用形如 `XM.bigType({ text, at, ... })`，返回一个 layer，交给 `XK` 的时间轴逐帧画。

### 三、素材 / 3D / 交互（较重，需要图片或 WebGL）

`globe`（3D 地球）`wall` `paperPile` `ribbons` `lens` `emerge` `bubble`
`notify` `popups` `loading` `squeeze` `specimen` `specimenGrid`

## 接线计划（分批）

- **批 1（自包含，无素材）**：`tex` `doodle` `mark` `thirds` `scanEye` + 6 个 `FX` 滤镜。
  这批接进 `app/fx/index.mjs`，按歌的 bpm/情绪自动挑，带总开关。
- **批 2（版式）**：`bigType` `bigQuote` `trackTitle` `wordCuts`。
  这批和现有 JIZURA PV 二选一（同一块画布，不要叠）。
- **批 3（素材/3D）**：`globe` `wall` `ribbons` `lens` `paperPile`。
  需要 `xm-assets` 里的素材，且 GL 在低端机上要测帧率。

## 许可

`vendor/fifi/LICENSE` 原样保留。仓库根 `THIRD-PARTY.md` 已登记。
组件被改动时在文件头注明 `// adapted from huiq777/fifi-video (MIT)`。
