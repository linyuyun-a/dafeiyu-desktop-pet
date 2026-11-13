# 设计：歌词 PV（JIZURA 引擎接入）

> 状态：P0 实现中。上游 [`852wa/JIZURA`](https://github.com/852wa/JIZURA)（MIT，字面 / lyric motion）。
> 本文只管「唱片机窗口里的歌词区怎么变成文字 PV」，不涉及桌面本体。

## 1. 目标与非目标

**目标**
- 唱片机放歌时，歌词区不是死板的 5 行字，而是跟着时间走的文字动画（登场 / 保持 / 退场 / 镜头 / 装饰）。
- 配色跟着歌的情绪走，而不是钉死一套。
- 她（大脑）和你（窗口）都能干预：她可以点风格，你可以手动切。

**非目标**
- 不做视频导出（JIZURA 的 `11_export.js` 不搬）。
- 不做 JIZURA 的编辑器 UI（`12_ui.js` 不搬）。
- 不改上游源码；只当库用（IIFE 挂全局 `J`）。

## 2. 为什么能当库用

| 上游位置 | 内容 | 我们怎么用 |
|---|---|---|
| `src/08_planner.js:288` | `J.plan(project, audio)` 歌词+曲 → 分镜计划 | 每首歌算一次，结果缓存 |
| `src/09_render.js:58` | `frame(ctx, plan, t, opt)` 画任意时刻一帧 | rAF 里用 `audio.currentTime` 调 |
| `src/09_render.js:82` | `opt.transparent` 跳过背景填充 | 只画字幕，背景仍是我们的卡片 |
| `src/10_audio.js:7` | `J.analyzeAudio(file)` BPM/能量/重拍 | P2 用来自动挑风格（P0 不用） |
| `src/11p_styles.js` | 12 套样式（配色+书体+编排 bias） | 作为「配色轴」的取值 |

关键结论：**它本身就是「plan 一次、逐帧画」的结构**，和播放器天然对齐；不需要 iframe，也不需要改它的代码。

## 3. 两条轴（核心设计）

上游把「配色」和「编排倾向」打包成一个 style。我们拆开：

### 轴 A：配色 / 质感（跟着歌的情绪走）

由 `styleId` 决定，可整体替换 `schemes` 覆盖颜色。默认池 5 套：

| styleId | 名称 | 底色 | 字色 | 强调 | 适用 |
|---|---|---|---|---|---|
| `ocean` | 深海 | #031A2E | #E4FAFF | #1FD2E6 | 抒情、安静、深夜 |
| `sunset` | 夕焼けグラデ | 橙红渐变 | 近白 | 金橙 | 温暖、离别 |
| `noir` | 新聞 | 米白纸 | 墨黑 | 朱红 | 叙事、怀旧、民谣 |
| `acid` | アシッド | 荧光绿/黑 | 白 | 品红 | 躁、电子、说唱 |
| `ink` | 墨と朱 | 宣纸白 | 墨黑 | 朱 | 古风、国风 |

（其余 `サクラ / 森の手帖 / ヴェイパー / シンセ80s / クラフト紙 / キャンディ / 金夜` 留作扩展，不默认启用，避免风格漂移。）

### 轴 B：编排（布局/登场/退场/镜头）

一套**稳定默认模板** + 按 BPM 的少量微调，不随配色变。P0 固定为「深海 bias」，P2 起允许按 BPM 覆盖 `fx.motion / density`。

## 4. 谁来决定（三级）

```
① 默认池            五套里挑一套（settings.pvStyle，默认 ocean）
② 按歌自动（P2）    能量/BPM/歌单名/她的心情 → styleId
③ 临场覆盖          她 [[pv:墨と朱]] ／ 你在唱片机点色点
```

**自动规则的输入只用可测量的量**（不靠模型猜歌名）：

| 信号 | 来源 | 映射 |
|---|---|---|
| BPM / 能量 | `J.analyzeAudio`（P2） | <80 且低能量 → `ocean`/`noir`；120+ 高能量 → `acid` |
| 歌单名关键词 | `playlists()` 的 name | 含「古风/中文/国风」→ `ink`；含「欧美/摇滚」→ `acid` |
| 她的心情 | `app/mood.mjs` 七轴 | sleepy 高 → `ocean`；joy 高 → `sunset` |
| 时辰 | 本地钟 | 23:30 后 → `ocean`（并降 motion） |

规则表放在 `app/pv.mjs`，纯函数，可单测。

## 5. 文件与接口

```
_probe/refs/jizura/src/*.js        上游源码（研究用，不提交产物）
scripts/build-jizura.mjs           拼接引擎 → app/jizura-engine.js
app/jizura-engine.js               构建产物（可重新生成，不手改）
app/pv.mjs                         我们的一层：plan 缓存 / 风格选择 / 渲染循环
app/player.html                    歌词区加 <canvas id="pv">
app/player.js                      播放时驱动 pv.mjs；无 plan 时回退现有 5 行字
```

`app/pv.mjs` 对外只暴露四个函数：

```js
createPv({ canvas, log })                 // 建渲染器（可失败：非 2d 环境）
setLyrics(lines)                          // 传 [{t, text}]，内部重建 LRC 文本
setStyle(styleId)                         // 切配色（重新 plan，不重载）
draw(t)                                   // t = audio.currentTime
setVisible(on)                            // 手动关闭歌词动画
```

## 6. 阶段与验收

### P0 最小可见版（本次）
- 打包 `_probe/refs/jizura/src` 的**核心 + 6 个表现包**（跳过 UI/导出/`11p_x2_*`），产物目标 < 1.5 MB。
- `player.html` 歌词区叠一块 canvas，`transparent: true`。
- 只做：当前行渲染 + 时间驱动 + 无 plan 时回退 5 行字。
- **验收**：放一首有 LRC 的歌，`pv.canvas` 有非空像素；拖动进度条画面跟着跳；暂停停格；关掉开关回到旧样式；`node --check` 通过。

### P1 可切换配色
- 设置页/唱片机加 5 个色点；`settings.pvStyle` 持久化；切风格 < 400ms。

### P2 按歌自动
- `J.analyzeAudio` 取 BPM/能量（缓存到 `userData/pv-an.__json`）；规则表 + 单测。

### P3 模板扩展
- 编排模板（slow / energetic / narrative）独立于配色；`[[pv:模板名]]` 也认。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 字体缺失（上游依赖 Google Fonts 18 个日文字族） | P0 接受系统字体回退；P1 起本地带 2 套子集化字体（约 3–5 MB） |
| 引擎体积（全量 3.56 MB） | P0 只带核心+6 包；`11p_x2_*` 与 horror 默认不搬 |
| 380×600 非上游原生比例 | 用 `aspect:'9:16'` 再按窗口裁；`scale` 选项调 DPR |
| 首帧预热卡顿 | 窗口打开时先 `plan()` 一次空跑一帧（预热 canvas/字体），再显示 |
| 同一首中途换风格会割裂 | 只允许换歌时换；切风格按钮作用于下一首 |
| 与桌宠表情/心情打架 | 心情只影响「选哪套」，不影响字的内容；她生气时字幕不变色是刻意的 |

## 8. 许可与合规

- 上游 MIT：保留版权与许可声明（`app/jizura-engine.js` 头部写入来源与 SHA）。
- 输出物（画面）权利归使用者；歌词与歌曲权利归各自权利人（与我们现有的歌词展示一致）。
- 不联网、不外发歌词：引擎只做本地 canvas 绘制。


## 附：可用的样式（24 套）

来自 JIZURA 引擎 `J.STYLES`，全部已在播放器「⋯ → 这一首的画面」里开放：
`noir` `crimson` `caution` `magenta` `paper` `hud` `mint` `specimen` `transit` `blueprint` `rouge` `mono`
`sakura` `ocean` `sunset` `forest` `vapor` `newsprint` `synth80` `kraft` `candy` `acid` `sumi` `gold`

色块预览色取 `schemes[0].accent / bg`；逐个点过一遍、画布像素均非空。详见 `docs/设计-播放器UI.md`。
