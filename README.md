# 荒芜拉普兰德 Codex 宠物

将《明日方舟》游戏内 Spine 3.8 基建 Q 版动画转换为 Codex sprite v2 宠物图集的开源构建项目。目前包含：

- `lappland-decadenza`：荒芜拉普兰德默认服装；
- `lappland-decadenza-unruly-humbleness`：荒芜拉普兰德「无序的谦卑」。

图像保持游戏内 Q 版造型，不使用 AI 补画。项目免费、非商业、非官方，与鹰角网络、OpenAI 均无隶属或背书关系。

> **版权提示**：本仓库原创代码采用 MIT License；《明日方舟》角色、名称、商标、模型和美术素材不属于 MIT 授权范围，相关权利归其权利人所有。本项目没有声称获得素材公开再分发授权；“免费”或“非商业”本身不等于获得授权。使用或再分发前请自行确认适用规则，权利人提出要求时应停止分发相关成品。

## 直接安装

不会构建代码的使用者请打开 GitHub 仓库的 **Releases** 页面，下载与系统对应的附件；不要下载绿色 **Code → Download ZIP**，源码压缩包不含可安装的宠物图集。

- Windows：下载 `lappland-codex-pets-v1.0.0-windows.zip`，完整解压后双击 `双击安装宠物-Windows.cmd`。
- macOS：下载 `lappland-codex-pets-v1.0.0-macos.zip`，完整解压后双击 `双击安装宠物-macOS.command`。

安装程序不需要管理员权限，会安装两套宠物并备份已有同名版本。安装完成后彻底退出并重新打开 Codex，在“设置 → 外观 → 宠物”中选择。完整步骤及手动备用方式见 [INSTALL.md](INSTALL.md)。

## 宠物格式与运行限制

每张图集为 `8×11` 单元格、`1536×2288` 像素，单格为 `192×208`：

- 前 9 行依次为 idle、向右跑、向左跑、挥手、姿势跳跃、失败、等待、工作和完成；
- 最后 2 行为 16 个注视方向，从向上开始按顺时针每次旋转 `22.5°`；
- `pet.json` 使用 `"spriteVersionNumber": 2`。

Codex `26.707.8479.0` 会让普通非 idle 动作播放 3 轮后回到 idle；这个时长不由宠物包控制。16 方向注视响应 Codex computer-use 的虚拟光标，不跟随普通鼠标。较旧的 Codex 版本可能无法读取 sprite v2，请先更新应用。

## 从源码构建

需要 Node.js `18.19.x`，或 `20.3` 及以上版本。构建过程会联网按 `sources.lock.json` 下载锁定的模型文件到 `.cache/`；原始模型、中间帧和生成物均被 Git 忽略。

```powershell
npm ci
npm run all
```

常用命令：

```powershell
npm run fetch:update-lock  # 仅在明确审核并接受上游素材变化时使用
npm run validate:fast      # 校验现有产物，跳过预览重建
npm run qa:previews        # 生成真实播放节奏预览和新旧对比
npm run runtime:verify     # 核对本机 Codex 运行时版本
npm run test:qa            # 运行时序、备份和安装冒烟测试
npm run install:local      # 备份并安装到当前用户的 Codex 目录
```

`spine-exporter` 0.8.0 的自动画布高度可能裁掉耳尖和鞋底。`postinstall` 会在严格版本检查后修正该问题；依赖实现变化时会停止，而不是盲目修改。

## 构建产物

生成内容位于被忽略的 `output/`：

```text
output/<pet-id>/
  final/
    pet.json
    spritesheet.webp
    spritesheet.png
    validation-local.json
    validation-hatch-pet.json
  qa/
    contact-sheet.png
    previews-runtime/*.gif
    comparisons/*.gif
```

校验覆盖图集尺寸与透明通道、空白格、左右跑逐像素镜像、动作接缝、锚点、16 方向顺序，以及前 9 行的 hatch-pet v1 兼容性。

## 开源与第三方内容

- [LICENSE](LICENSE) 仅授权本项目贡献者原创的代码与文档，不授权游戏素材或其他第三方内容。
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 记录模型来源、工具来源及权利边界。
- Release 中如包含渲染后的宠物图集，其仍含第三方游戏美术，不因打包或转换而成为 MIT 内容。

欢迎提交构建修复和兼容性改进。请勿将原始 `.skel`、`.atlas`、纹理、中间帧、缓存或本机备份提交到仓库。
