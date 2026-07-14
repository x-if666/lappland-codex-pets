# 荒芜拉普兰德 Codex 宠物

给 Codex 做的荒芜拉普兰德小人，包含默认服装和「无序的谦卑」。不是像素重画，而是由游戏内 Q 版 Spine 动画转换而来，也没有用 AI 补图。

## 下载

- [Windows 一键安装包](https://github.com/x-if666/lappland-codex-pets/releases/download/v1.0.0/lappland-codex-pets-v1.0.0-windows.zip)
- [macOS 一键安装包](https://github.com/x-if666/lappland-codex-pets/releases/download/v1.0.0/lappland-codex-pets-v1.0.0-macos.zip)

下载对应的 ZIP，完整解压，再双击里面的中文安装文件。安装好后重启 Codex，到「设置 → 外观 → 宠物」里选择拉普兰德就可以了。

安装不需要管理员权限，已有的同名宠物会自动备份。macOS 如果提示无法打开，请右键 `.command` 文件并选择「打开」。更详细的步骤在 [INSTALL.md](INSTALL.md)。

## 里面有什么

- 荒芜拉普兰德，默认服装
- 荒芜拉普兰德·无序的谦卑
- idle、移动、挥手、跳跃、等待、工作、完成和失败动作
- sprite v2 的 16 方向注视

图集尺寸是 `1536×2288`，单格 `192×208`。已在 Codex Desktop `26.707.8479.0` 上验证。

有两个 Codex 本身的限制：普通动作播放三轮后会回到 idle；16 方向注视只在 Codex 操作电脑时响应虚拟光标，不会跟随普通鼠标。

## 想自己构建

需要 Node.js 18.19，或 20.3 以上版本：

```powershell
npm ci
npm run all
npm run install:local
```

素材会按 `sources.lock.json` 下载到本地缓存。原始模型、中间帧和成品都不会提交进 Git。其他构建命令可以在 [package.json](package.json) 里查看。

## 说明

这是一个免费、非商业的非官方项目。仓库里的原创代码使用 MIT License；《明日方舟》角色和美术版权归原权利人，不在 MIT 授权范围内。来源与依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

遇到安装或显示问题，可以直接提 [Issue](https://github.com/x-if666/lappland-codex-pets/issues)。
