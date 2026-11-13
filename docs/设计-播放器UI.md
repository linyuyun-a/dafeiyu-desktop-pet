# 唱片机界面（三轮收拾记录）

> 对象：`app/player.html` / `player.css` / `player.js`，以及主进程里的 `player:*` IPC。
> 目标：从「功能原型」做到「能长期摆在桌面上不碍眼」。

## 一、排布（第一轮）

| 项 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| 碟片 | `36vmin / 260px` 上限，几乎贴页签 | `clamp(132px, min(33vmin, 30vh), 236px)`，上留 14px | 两个图层撞在一起像 bug |
| 歌名 | 15px / 600 | 18px / 650，行高 1.3 | 它是这一窗的主信息 |
| 歌手 | 11px | 11.5px，opacity .9 | 次要信息要退后 |
| 页签 | 拉满整行 | `max-width: 340px`，左对齐 | 大窗时两颗药丸撑满很怪 |
| 频谱 | 34px | 26px | 把高度让给歌词 |
| 底部 | 四段散着 | 进度 → 控制 → 提示，`#hint { margin-top:auto }` | 控制条贴底，中间区自然吃满 |

配色从歌名下方收进右上角「⋯」，做成**底部抽屉**：标题 + 24 个样式格子 + 一句「默认跟着歌的脾气自动挑，点一下会锁住这一首」。抽屉 `width: min(460px, 100% - 28px)`，`bottom: 116px`（让开频谱与进度条）。

## 二、手感（第二轮）

- 键盘：`空格` 播放/暂停、`←/→` ±5 秒、`↑/↓` 音量 ±5%。焦点在输入框时全部让开（`isTyping()`）。
- 音量条平时收起（`width 0 / opacity 0`），鼠标进控制条用 `pointerenter` 加 `.vol-open` 展开到 84px；**不用 `:hover`**，因为 CDP 合成的鼠标在透明窗里不产生 `:hover` 状态，没法自动验证。
- 按钮按压：`transform: scale(.97)`，120ms，`cubic-bezier(.16,1,.3,1)`；颜色过渡 160ms。
- 实测：空格 `false→true→false`；`→` 9.6→14.9；`←` 14.9→10.3；`↓` 音量 0.80→0.75；音量条 `0 → 84px → 0`。

## 三、海报模式与封套淡入（第三轮）

- `F` 或双击唱片进海报；`Esc` 先退海报（不关窗）。
- 主进程 `player:poster`：**不用 `setFullScreen`**（透明无边框窗在 Windows 上不总是生效，实测只到 901×916），改成
  `setMaximumSize(20000,20000) → setBounds(display.workArea) → setAlwaysOnTop('screen-saver')`，退出时还原 bounds 与 `setMaximumSize(900,1200)`。
  实测 771×911 → **1464×868** → 退出回到 771×911；海报尺寸不写进 `settings.playerBounds`（`remember()` 里 `isFullScreen` 守卫其实用不上，但保留）。
- 海报态隐藏页签、频谱、关闭键；唱片 `clamp(180px,34vh,360px)`；歌名 `clamp(22px,2.4vh,32px)`。
- 封套换歌：先 180ms 淡出 → 换 `src` → 淡入；采样能看到 `0.98 → 0.95 → 0.90 → 0.85`。

## 四、歌词 PV 样式（24 套）

引擎 `app/jizura-engine.js`（MIT，852wa/JIZURA，`scripts/build-jizura.mjs` 打包）里共有 24 套样式，此前只暴露 5 套。现在全部开放：

- 冷 / 极简：`noir` `crimson` `caution` `magenta` `paper` `hud` `mint` `specimen` `transit` `blueprint` `rouge` `mono`
- 情绪 / 主题：`sakura` `ocean` `sunset` `forest` `vapor` `newsprint` `synth80` `kraft` `candy` `acid` `sumi` `gold`

选择器用 `#pvDots` 里的 `.pvbtn`（12px 色块 + 名字，3 列网格，最高 168px 可滚）。色块颜色从引擎里取：`J.STYLES[id].schemes[0].accent / bg`，所以换了引擎也不用改表。

**逐个冒烟**：24 套全部点一遍，读 `#pv` 画布 alpha 计数，全部 > 0（`specimen` 最低 1191，是极简风格；`kraft` 最高 241935）。

### pv-tool 为什么没有搬代码

`https://github.com/DanteAlighieri13210914/pv-tool`（PixiJS 8 + GSAP，16 模板 / 54 效果）许可证是 **Non-Commercial，且第 3 条禁止 embedding/bundling into any product**。所以只能借思路（同心圆、扫描线、构图辅助线那类「几何 overlay」），不能把它的 effect 模块打进我们的包。当前 24 套样式全部来自 MIT 的 JIZURA 引擎。

## 五、已知取舍

- 抽屉会压住一小块歌词区（窗口内没有别的地方能放它而不碰唱片）；收起即无影响。
- 窄窗（≤470px）歌单页收起歌手列，只留歌名 + 时长。
- 24 格样式表在小窗里要滚动，不是一屏全见。
