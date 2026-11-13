# 大肥鱼桌宠（deepseek-pet）

一个跑在 Windows 桌面上的 Live2D 桌宠：**身体**是 Live2D 模型 + 物理 + 表情/动作层，
**大脑**接 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 的人格与记忆，
**嘴**是本地 TTS（Qwen3-TTS 克隆 + 情绪母带），**耳朵**是本地 ASR（SenseVoice）。

## 已实现

- Live2D 渲染 / 透明窗口 / 按轮廓的鼠标穿透 / 拖动与缩放
- 动作与表情：语义标记（`[[act:…]]`、`[[face:…]]`、`[[wear:…]]`、`[[play:…]]`）+ 生命层待机（呼吸、眨眼、视线跟随）
- 与 AstrBot 的流式对话（以 `complete` 全文为准，逐字吐字），打标给桌宠做动作
- 主动开口：本地决定「什么时候说」，AstrBot 决定「说什么」
- 心情（七轴）与触摸反馈、装扮系统（9 个槽位）、对话记录窗
- 本地语音合成（四条情绪母带）、语音转文字、长按说话
- 网易云唱片机：搜索 / 队列 / 扫码登录 / 进度条，可拖动可缩放；歌词 PV（24 套样式）
- 纯音乐画面（模板演歌曲信息）、工作状态联动（DSH 插件状态）
- 播放器界面：三档自适应排布、键盘操作（空格 / ←→ / ↑↓）、`F` 海报模式、封套淡入
- 纯音乐动效层（`app/fx/`，按「家族」配对）：手绘墨线、纸纹网格、图纸几何

## 快速开始

```bash
npm install          # 依赖
npm run core         # 下载 Live2D Cubism Core（专有许可，不随仓库分发）
npm run app -- --model "D:/path/to/your.model3.json"
```

**模型需要自备**：本仓库不含任何 Live2D 模型（皮套版权归原作者）。
首次运行也可以让它引导你选择 `.model3.json`。

大脑配置：复制 `brain.config.example.json` 为 `brain.config.json`，填入你的 AstrBot 地址与 API Key
（这个文件已被 `.gitignore` 忽略，不会进仓库）。

## 声音（需要自备）

语音合成用的四条**情绪母带**（`app/tts/voices/*.wav`）是从一段参考音克隆出来的，
涉及原声权利，**不随仓库分发**。没有它们时桌宠照样能打字对话，只是不出声。

想让她出声：

1. 准备一段你自己的参考音（3–10 秒干净人声），以及它对应的文字；
2. 用 `app/tts/server.py` 同目录的母带脚本（`_probe/make-masters.py` 里是做法）
   按 soft / angry / sleepy / happy 四种语气各生成一条；
3. 放到 `app/tts/voices/`，连同同名 `.txt`（参考音原文）与 `index.json`。

## 开发

```bash
npm run app                    # 开发运行
npm run pack                   # 打包（默认不带模型；设置 STAGE_MODEL_SRC 才内置）
node scripts/fetch-core.mjs    # 单独补 Core
```

## 许可

代码以 **MIT** 发布，见 [LICENSE](LICENSE)。
第三方组件，以及明确不随仓库分发的内容（Live2D Core / 模型），见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 声明

- 本项目与 Live2D Inc.、网易云音乐、AstrBot 官方均无隶属关系。
- 音乐与歌词在运行时通过用户自己的账号获取，仅供个人使用；请勿用于再分发。
