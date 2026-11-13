# M0 验收现场（2026-11-04）

M0 = 地基：透明窗口 + 模型跑起来 + 引擎能力全部验过。这里放的是**当时的证据**，
不是设计稿。跑一遍能复现（命令见下）。

## 结论

14 项自检，0 失败。原始日志：[M0-自检.log](M0-自检.log)

| 检查项 | 结果 |
|---|---|
| 模型显示 | ✓ 透明背景（四角 alpha = 0） |
| 待机动作 | ✓ 两帧差异 14.93%（IDLE 在动） |
| 帧率 | ✓ 54.9 fps（另一轮 82 fps） |
| 表情 | ✓ heart / cry / dizzy / blush / squint 各一张 |
| 动作 | ✓ hand_up / grass_out / point_out 各一张 |
| 口型 | ✓ `ParamMouthOpenY` 0/1 两张 |
| 视线跟随 | ✓ 指针左上 / 右下两张 |
| 命中区 | ✓ 点击 Head、Body 都触发 `hit` 事件 |
| 内存 | JS 堆 117 MB；纹理显存估算 64 MB |
| 启动 | ready ≈ 1.0–1.4 s |

## 图

- `01-窗口-1倍.png` — 默认大小（232×480）的实际窗口截图
- `02-缩放对比.png` — 0.7× / 1× / 1.8× 三档（窗口 161×336 / 232×480 / 395×824）
- `03-表情五连.png` — 默认 + 5 个表情的脸部特写
- `04-动作三连.png` — 举手 / 狗尾草 / 竖手指
- `05-口型与视线.png` — 闭嘴/张嘴、看向左上/右下
- `06-M1-摸头与戳身体.png` — 摸头（爱心眼）/ 戳身体（脸红）/ 平时
- `M1-自检.log` — M1 版 17 项自检原始日志

## M1（会动会看）验收

17 项 0 失败：

| 检查项 | 结果 |
|---|---|
| 拖动 | ✓ 主进程轮询光标跟随；松手写 `window.json` |
| 位置记忆 | ✓ 重启回到上次位置（`记忆={"x":1110,"y":365,"zoom":1}`） |
| 缩放 | ✓ 右下角把手 / `Ctrl+滚轮` / 托盘三档 / 双击复位 |
| 托盘 | ✓ 显示隐藏、大小、穿透、置顶、退出 |
| 点击穿透 | ✓ `setIgnoreMouseEvents(true, {forward:true})` |
| 摸头反应 | ✓ 爱心眼 + `TapBody` |
| 戳身体反应 | ✓ 脸红 |
| 空闲小动作 | 每 20–45 s 随机表情（要挂机 5 分钟才看得到，未截图） |
| CPU | 30 fps ≈ 5.2%、15 fps ≈ 3.4%（`app.getAppMetrics()`） |
| 后台降帧 | ✓ 失焦 15 / 隐藏 5 |

⚠️ 量 CPU 别用 `Get-Process electron` 求和：这台机器上还有 DSH 自己的 electron 进程，会把别人的算进来（曾量出 90–200% 的假数）。桌宠自己报的 `app.getAppMetrics()` 才准。

## 复现

```bash
npm run build
# 本环境（DSH 沙箱）额外需要 --no-sandbox 与可写 user-data-dir，并去掉 harness 注入的 ELECTRON_RUN_AS_NODE
env -u ELECTRON_RUN_AS_NODE PET_CHECK=1 PET_ZOOM=1 \
  ./node_modules/electron/dist/electron.exe . \
  --no-sandbox --user-data-dir="$(pwd)/_probe/udpet"
```

用户桌面直接 `npm run dev` 即可，不需要那两个参数。

## 两个必须记住的坑

1. **Core 版本**：必须用 `vendor/cubism-r5/` 那份（含 `MocVersion_53`）。旧的 207 KB Core 5.1.0 会被引擎拒绝。
2. **遮罩上限**：本模型单 drawable 用了 49 个 clipping mask，引擎默认只支持 36。`scripts/patch-engine.mjs` 把 mask render texture 提到 2 张（已挂 `postinstall`）；不补就会每帧报错且**脸画错**。

## M2 · 会说话（文字）

| # | 证据 | 说明 |
|---|---|---|
| 07 | `07-M2-对话气泡.png` | 气泡（带尾巴）+ 输入框，角色不被压住 |
| 08 | `08-M2-错误兜底.png` | 平台没起：气泡写"没连上她的大脑：…"，同时圈圈眼 |
| 09 | `09-M2-说话口型.png` | 说话过程中三帧，`ParamMouthOpenY` 开合可见 |

自检（`PET_BRAIN=mock PET_CHATCHECK=1`）：5 项 0 失败（气泡出现文字 / 逐字流式 / 打断生效 / 完整一轮 / 聊天落盘）。

> 平台真流式还没验：写这份记录时 `8765/6185/8768` 全是 `ECONNREFUSED`。

## M3 · 动作 / 二次运动 / 视线（2026-11-04）

| # | 证据 | 说明 |
|---|---|---|
| 10 | `10-手势四连.png` | 伸懒腰、挥手、害羞（双手到脸侧 + 脸红）、蹦一下 |
| 11 | `11-摸头与戳身体.png` | 摸头 → 脸红 + 抬手；戳身子 → 圈圈眼 + 双手摊开 |

自检（`PET_M3CHECK=1`）：7 项 0 失败 —— 视线左 −16.4°/右 +15.7°、眼球 0.67、关闭回正 0.00、后发峰值 0.23→0.00、尾巴 1.9°、手势 13+1 个、动作期间视线让位 0.0。

M0 回归（`PET_CHECK=1`）：17 项 0 失败（命中区已改成"内容分区"判定，见下）。

三个坑：

1. **动作里写 `ParamAngle*` 会被物理覆盖** —— 只有 OP 参数与手臂/眼嘴/`key*`/衣服这些自由参数能写进 `motion3.json`。
2. **转头要写两层** —— `ParamAngleX/Y` 驱动网格（看得见转头），`AngleX/AngleY`（cdi3 控制器 OX/OY）驱动物理（头发会甩）。只写前者头发死、只写后者头不动。静止时"写一次 0 就放手"，动作期间撤覆盖。
3. **引擎 HitAreas 对这个模型不可用** —— `ArtMesh340/543` 的包围盒落在角色外。改成拿 `contentBox` 归一化点击：上 30% = 头、30–68% = 身子（`zoneAt()`）。

> 附带发现：Pixi 的 PointerHandler 在 canvas 上 `stopImmediatePropagation`，自绘的指针监听必须挂在 **window 的捕获阶段**，否则点击收不到。

**边距**：左右必须不等——内容左缘钉在 8% 窗口宽、右边至少 3%、纵向 90%（1× 窗口实测左 35 / 右 18 px）。挥手/竖指往窗口左边伸，对称百分比会在那侧切到。

**镜像链翻符号**：`secondary.ts` 里侧发 L 用 `sign: -1`，否则左右头发会朝反方向甩。

**上下要取反**：屏幕 y 向下为正，模型 `AngleY` 正方向是抬头，所以 `gaze.ts` 里 `targetY = -dy/(h/2)`；左右不反。

## M3+ · 待机生命层 / 触发层（2026-11-04 深夜）

| # | 证据 | 说明 |
|---|---|---|
| 12 | `_probe/spike-canvas.png` | 生命层开着的默认姿态：呼吸 / 微晃不改变构图，眼睛是睁开的 |

自检：

- `PET_ALIVECHECK=1`：**11 项 0 失败** —— 呼吸 `PositionY` 极差 0.55、周期 3.4–4.0 s；`AngleZ` 极差 2.36；
  12 s 内眨眼 3–6 次、最低 0.00、间隔差 0.8–3.5 s；关闭后回中位且眼睛 `1.00`；重开 gain 0.99。
- `PET_TRIGCHECK=1`：**10 项 0 失败**（摸头/戳身/三连戳/长按/悬停/锁屏/对话出错/勿扰两条/统计）。
- `PET_M3CHECK=1` / `PET_CHATCHECK=1`：7 / 5 项 0 失败 —— 生命层没有和视线、手势、气泡抢参数。

诊断要点：**原厂 `idle.motion3.json` 里没有身体曲线也没有眨眼**（21 条全是特效与呆滞度），
所以"待机像雕像"不是动作不自然，而是根本没有待机动作 —— 详情见
[学习-动作节奏与触发.md](../学习-动作节奏与触发.md) 第五节。

## 分区反应 / 成对动作（PET_ZONETEST=1）

```
env -u ELECTRON_RUN_AS_NODE PET_ZONETEST=1 timeout 40 ./node_modules/electron/dist/electron.exe . \
  --no-sandbox --user-data-dir="$(pwd)/_data/profile"
```

对着 11 个分区各发一次合成点击（`PointerEvent`，`isTrusted=false`，不会拖窗口），
每次停 160ms 截一张 `_probe/zone-<分区>.png`。自检 11/11 分区命中正确，日志逐条对应：

```
[zonetest] 点 EarL → EarL
[probe] 参数脉冲 LEar1+LEar2+LEar3 → 1
[probe] 摸 EarL
[zonetest] 截图 EarL → ...\_probe\zone-EarL.png
```

`_probe/grid-zones.png` 是 11 张拼图（脸红/耳鳍/护胸/裙摆/并腿/跳/尾巴/抬手肉眼可分）。

### 坑：沙箱留下的 ACL 会让 Electron 静默退出

现象：只打出 `[main] boot ...` 就退出、日志里没有渲染层任何一行，stderr 有
`Unable to move the cache: 拒绝访问。 (0x5)`。原因是工程目录曾被沙箱进程建过：
`icacls .` 能看到 `Everyone:(CI)(DENY)(DC)`（拒删子项），`_data/profile` 继承它，Chromium 改名缓存目录失败 → 直接退出。

修复（一次即可，之后新目录不再继承）：

```bash
icacls . /remove:d "Everyone"
rm -rf _data/profile && mkdir -p _data/profile
```

另外：**上一个实例还活着时，新实例会因为单实例锁静默退出**（exit code 0、没有渲染层日志）。
排查前先 `Get-Process electron | Stop-Process -Force`。
