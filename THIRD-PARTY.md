# 第三方组件与许可

本项目自身以 MIT 许可发布（见 `LICENSE`）。下面是运行时会用到的第三方组件，
以及**明确不随本仓库分发**的部分。

## 运行时依赖（npm 安装，不随仓库分发）

| 组件 | 许可 | 用途 |
|---|---|---|
| [electron](https://github.com/electron/electron) | MIT | 桌面外壳 |
| [pixi.js](https://github.com/pixijs/pixijs) | MIT | 渲染 |
| [untitled-pixi-live2d-engine](https://github.com/guansss/pixi-live2d-display) | MIT | Live2D 的 PixiJS 绑定 |
| [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) | MIT | 网易云接口（点歌 / 歌词 / 登录） |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | 截图后处理（仅开发用） |

## 内联进 `app/jizura-engine.js` 的上游代码

| 组件 | 许可 | 说明 |
|---|---|---|
| [852wa/JIZURA](https://github.com/852wa/JIZURA) | MIT | 歌词文字 PV 引擎。`scripts/build-jizura.mjs` 从上游 `src/` 按依赖顺序拼接，产物头部保留 MIT 声明与上游 commit。 |

## 随仓库内联的动效运行时（`app/fx/vendor/fifi/`）

| 组件 | 许可 | 说明 |
|---|---|---|
| [huiq777/fifi-video](https://github.com/huiq777/fifi-video) | MIT | 手绘墨线 / 纸纹等 Canvas 动效运行时。原样复制 `lib.js` `timeline.js` `xk.js` `xm-core.js` `xm-ds.js` `xm-doodle.js` `xm-tex.js`，未修改；同目录保留上游 `LICENSE`。由 `app/fx/index.mjs` 调用。 |

**只看不抄**（许可不允许把代码打包进本项目，仅作视觉参考）：

| 组件 | 许可 | 为什么不能直接用 |
|---|---|---|
| [DanteAlighieri13210914/pv-tool](https://github.com/DanteAlighieri13210914/pv-tool) | Non-Commercial，且明确禁止 embedding / bundling into any product | 只能借它的视觉思路（几何母题、边缘刻度、3 秒段落）自己实现 |
| 某剪映文字预设合集（本地） | 允许学习/修改/分享，禁止销售预设本身 | 仅作动画参考，未入库 |

## 明确**不**随仓库分发

| 组件 | 原因 |
|---|---|
| **Live2D Cubism Core**（`vendor/live2dcubismcore.min.js`） | Live2D 专有许可，禁止再分发。请运行 `npm run core` 从官方地址自行下载。 |
| **Live2D 模型**（`assets/model/`） | 皮套版权归原作者，本项目只提供加载能力，用户需自备 `.model3.json`。 |
| `_probe/`、`_research/` 下的参考实现 | 仅用于研究，来源与许可各自归属上游，未纳入本仓库。 |

## 外部服务

- **AstrBot**（对话人格与记忆）是独立部署的服务，本项目只通过它的 HTTP API 调用，不含其代码。
- **网易云音乐**：搜索、音频流、歌词均由官方接口在运行时获取，需用户自行登录自己的账号；请遵守其服务条款，不要用于再分发音乐内容。
