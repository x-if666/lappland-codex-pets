# Third-Party Notices

本项目是免费、非商业、非官方的爱好者项目。以下声明用于说明来源与权利边界，不表示任何权利人授权、认可或背书本项目。

## 《明日方舟》及游戏美术

《明日方舟》、拉普兰德及相关名称、角色设计、商标、模型、动画、纹理和美术素材的权利归其各自权利人所有，包括上海鹰角网络科技有限公司及其关联权利主体。

本项目构建时使用的模型标识为：

- `1038_whitw2`：默认服装；
- `1038_whitw2_sale#15`：「无序的谦卑」。

这些内容不属于本仓库的 MIT License。对模型进行抽帧、缩放、镜像、排版或转换为 WebP，不会改变其第三方权利属性。公开、免费或非商业使用也不自动构成授权。

## Ark-Models

模型文件按锁定地址从玩家维护的 [isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models) 仓库读取。Ark-Models 是素材获取来源；本项目不声称该仓库所有者是游戏素材权利人，也不把该来源描述为对公开再分发的授权。

具体文件路径和 SHA-256 记录在 `sources.lock.json`。原始 `.skel`、`.atlas` 和纹理不会提交到本 Git 仓库。

## OpenAI Codex 与 hatch-pet

宠物图集结构参考 OpenAI 的 [hatch-pet skill](https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet)，并在本地使用其 v1 校验流程检查前 9 行兼容性。

OpenAI、Codex 及相关标识归其权利人所有。本项目不是 OpenAI 官方宠物包，OpenAI 未对本项目提供背书。

## 构建依赖

主要构建依赖包括：

- [spine-exporter](https://github.com/Nattsu39/spine-exporter)
- [sharp](https://github.com/lovell/sharp)
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
- [cwebp-bin](https://github.com/imagemin/cwebp-bin)

各依赖继续适用其自己的许可证和通知；准确版本由 `package-lock.json` 锁定。MIT License 只覆盖本项目贡献者原创部分，不替代任何依赖或其所携二进制组件的许可证。

## Release 成品

GitHub Release 如附带 `spritesheet.webp`，其中包含由第三方游戏美术渲染而来的图像。该文件不会因为与 MIT 代码一同发布而获得 MIT 授权。下载者应将其用于个人、本地、非商业用途，并自行确认所在地法律和相关服务条款。

如果你代表相关权利人并认为 Release 中的内容需要移除，请通过本仓库的 Issue 联系维护者；维护者应优先停止分发相关 Release 成品。
