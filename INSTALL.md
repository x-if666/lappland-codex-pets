# 安装荒芜拉普兰德 Codex 宠物

Release 中的 Windows 或 macOS 压缩包都包含两套服装。安装不需要 Git、Node.js 或管理员权限，也不会修改 Codex 应用程序。

## 安装前

1. 使用原生 Codex Desktop，并尽量更新到当前版本。宠物使用 sprite v2；已验证的运行时基线为 `26.707.8479.0`。
2. 从 GitHub **Releases** 下载与你的系统对应的 ZIP。不要选择 **Code → Download ZIP**，源码包没有宠物图集。
3. 先把 ZIP 完整解压到普通文件夹，不要直接在压缩包预览窗口中运行安装文件。
4. 完全退出 Codex。只关闭主窗口可能仍有后台进程，必要时从系统托盘或菜单栏退出。

## Windows 一键安装

1. 下载并解压 `lappland-codex-pets-v1.0.0-windows.zip`。
2. 双击 `双击安装宠物-Windows.cmd`。
3. 等待窗口显示安装成功；不需要输入管理员密码。
4. 彻底退出并重新打开 Codex。
5. 打开“设置 → 外观 → 宠物”，选择“荒芜拉普兰德”或“荒芜拉普兰德·无序的谦卑”。

如果 Windows 阻止脚本运行，不必关闭系统安全功能；请先核对下载来源和 `SHA256SUMS.txt`，也可以直接使用下方的手动安装。

## macOS 一键安装

1. 下载并解压 `lappland-codex-pets-v1.0.0-macos.zip`。
2. 双击 `双击安装宠物-macOS.command`。
3. 若系统阻止首次打开，可在 Finder 中右键该文件并选择“打开”，确认文件确实来自本项目 Release 后再继续。
4. 等待终端窗口显示安装成功；脚本不会要求管理员密码。
5. 彻底退出并重新打开 Codex，在“设置 → 外观 → 宠物”中选择宠物。

如果仍无法运行 `.command` 文件，请使用手动安装，不要关闭 Gatekeeper 或其他系统安全保护。

## 手动安装备用方式

安装包中的 `pets` 文件夹下应有两个完整目录：

```text
pets/
  lappland-decadenza/
    pet.json
    spritesheet.webp
  lappland-decadenza-unruly-humbleness/
    pet.json
    spritesheet.webp
```

将这两个宠物目录复制到 Codex 用户目录的 `pets` 文件夹中：

- Windows 默认位置：`%USERPROFILE%\.codex\pets\`
- macOS 默认位置：`~/.codex/pets/`
- 如果设置了 `CODEX_HOME`：复制到该目录下的 `pets` 文件夹。

Windows 可在文件资源管理器地址栏粘贴 `%USERPROFILE%\.codex\pets`。macOS 可在 Finder 中按 `Command+Shift+G`，输入 `~/.codex/pets`。目标文件夹不存在时可以新建。

最终必须是 `<Codex 用户目录>/pets/<pet-id>/pet.json`，不要形成 `pets/pets/<pet-id>` 或 `<pet-id>/<pet-id>` 的多余嵌套。

## 覆盖、备份与校验

一键安装程序会：

- 优先使用 `CODEX_HOME`，否则使用当前用户默认的 `.codex` 目录；
- 先检查两套宠物的 `pet.json` 与 `spritesheet.webp` 是否齐全，任一缺失都不会开始复制；
- 将已有同名宠物备份到 `<Codex 用户目录>/pet-backups/<时间戳>/<pet-id>/`；
- 复制完成后校验文件，失败时以非零状态退出并保留可诊断信息。

Release 页面提供 `SHA256SUMS.txt`。如下载损坏、文件数量不对或安全软件发出警告，请停止安装，重新从 Release 下载并核对哈希。

## 常见问题

### 安装成功但列表里没有宠物

- 完全退出并重新打开 Codex；
- 检查是否复制到了当前用户实际使用的 `CODEX_HOME`；
- 检查目录是否多套了一层 `pets`；
- 更新 Codex Desktop，旧版本可能不支持 sprite v2；
- 确认每个宠物目录内同时存在 `pet.json` 和 `spritesheet.webp`。

### 可以看到宠物，但动作很快回到 idle

这是当前 Codex 的运行逻辑：普通非 idle 状态播放 3 轮后会回到 idle，宠物包无法改变该时长。

### 注视动作不跟随普通鼠标

sprite v2 的 16 方向注视只响应 Codex computer-use 的虚拟光标，不响应普通系统鼠标。

### 想卸载

退出 Codex，删除 `.codex/pets/` 中上述两个 `lappland-...` 目录，再重新打开 Codex。不要删除整个 `.codex` 目录。
