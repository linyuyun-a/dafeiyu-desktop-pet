# 署名与素材来源

这个项目是「大肥鱼（DeepSeek-chan）」的桌宠外壳。**角色与皮套不是本项目创作的**，
这里把来源和署名写清楚，也把「哪些东西在仓库里、哪些不在」标明白。

## 角色与皮套

| 项 | 内容 |
| --- | --- |
| 模型名称 | DeepSeek-chan（大肥鱼） |
| 原画及拆分 | **神宫凉子** |
| Live2D 建模 | **霓虹猫_NeonNeko** |
| 配布方 / 来源 | 神宫凉子 免费配布模型（B 站搜索「神宫凉子」进入作者主页） |
| 许可 | 作者发布的《DeepSeek 免费 Live2D 模型使用须知》 |

按该须知，允许个人直播、视频创作及由此获得的平台收益，也允许二次创作；
**但不允许二次销售，也不允许把完整模型文件重新上传到任何平台供他人直接下载**，
并且不得删除或隐藏原作者信息。因此：

- 本仓库 **不包含** 该模型的 `.moc3` / 纹理 / 动作文件（它们在你自己的机器上）。
- 想在本项目里用这个皮套，请到作者的原始发布页面获取，再把模型目录指给程序：

  ```bash
  npm run app -- --model "D:/path/to/DeepSeek-chan/大肥鱼.model3.json"
  ```

  也可以在首次启动的引导里选 `.model3.json`，或把模型放进 `assets/model/`（该目录已在
  `.gitignore` 里，不会被提交）。

如果你不是原作者、也没有作者的书面授权，请不要把模型文件放进本仓库的提交里——
那会违反上面的「禁止擅自重新分发」。

## Live2D Cubism Core

`vendor/live2dcubismcore.min.js` 属于 Live2D 公司的专有软件，**不随本仓库分发**。
`npm run core` 会从官方 SDK 下载对应版本（当前校验 `Cubism 5 SDK for Web R5`，228042 字节）。

## 第三方代码

见 [THIRD-PARTY.md](THIRD-PARTY.md)：

- [852wa/JIZURA](https://github.com/852wa/JIZURA)（MIT）——歌词 PV 引擎，内联为 `app/jizura-engine.js`
- [huiq777/fifi-video](https://github.com/huiq777/fifi-video)（MIT）——手绘动效运行时，内联在 `app/fx/vendor/fifi/`
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)——大脑（外部服务，不随本仓库分发）
- 网易云音乐——曲库与播放（外部服务，需自备账号）

## 本项目

- 代码：MIT，见 [LICENSE](LICENSE)
- 作者：linyuyun-a
