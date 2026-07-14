#!/bin/sh
set -eu

PET_ONE='lappland-decadenza'
PET_TWO='lappland-decadenza-unruly-humbleness'
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
SOURCE_ROOT="$SCRIPT_DIR/pets"
TARGET_HOME=${CODEX_HOME:-"$HOME/.codex"}
PETS_ROOT="$TARGET_HOME/pets"
INSTALL_STAMP="$(date '+%Y%m%d-%H%M%S')-$$"
BACKUP_ROOT="$TARGET_HOME/pet-backups/$INSTALL_STAMP"

on_exit() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    printf '\n%s\n' '============================================================'
    printf '%s\n' '[安装失败 / Installation failed]'
    printf '%s\n' '安装不需要管理员权限。请确认已完整解压 ZIP，再重新运行。'
    printf '%s\n' 'No administrator permission is required. Extract the whole ZIP and try again.'
    printf '%s\n' '如仍失败，请打开同目录的“安装说明.html”。'
    printf '%s\n' '============================================================'
  fi
  if [ -t 0 ] && [ "${CODEX_PET_INSTALLER_NO_PAUSE:-}" != '1' ]; then
    printf '\n按回车关闭 / Press Return to close: '
    IFS= read -r _answer || true
  fi
  exit "$status"
}
trap on_exit EXIT

fail() {
  printf '[错误 / Error] %s\n' "$1" >&2
  exit 1
}

validate_source() {
  pet_id=$1
  pet_source="$SOURCE_ROOT/$pet_id"
  [ -d "$pet_source" ] || fail "安装包不完整，缺少目录：pets/$pet_id"
  [ ! -L "$pet_source" ] || fail "安装源不能是符号链接：pets/$pet_id"
  [ -f "$pet_source/pet.json" ] || fail "安装包不完整，缺少：pets/$pet_id/pet.json"
  [ -f "$pet_source/spritesheet.webp" ] || fail "安装包不完整，缺少：pets/$pet_id/spritesheet.webp"
}

file_sha256() {
  hash_line=$(shasum -a 256 "$1") || fail "无法计算 SHA-256：$1"
  printf '%s' "${hash_line%% *}"
}

verify_copy() {
  source_hash=$(file_sha256 "$1")
  destination_hash=$(file_sha256 "$2")
  [ "$source_hash" = "$destination_hash" ] || fail "SHA-256 校验失败：$2"
}

install_pet() {
  pet_id=$1
  pet_source="$SOURCE_ROOT/$pet_id"
  pet_destination="$PETS_ROOT/$pet_id"
  pet_backup="$BACKUP_ROOT/$pet_id"

  [ ! -L "$pet_destination" ] || fail "目标路径不能是符号链接：$pet_destination"
  [ ! -e "$pet_destination" ] || [ -d "$pet_destination" ] \
    || fail "目标路径不是文件夹：$pet_destination"

  pet_stage=$(mktemp -d "$PETS_ROOT/.$pet_id.installing.XXXXXX") \
    || fail "无法创建临时安装目录：$PETS_ROOT"
  cp "$pet_source/pet.json" "$pet_stage/pet.json" \
    || fail "复制 pet.json 失败：$pet_id"
  cp "$pet_source/spritesheet.webp" "$pet_stage/spritesheet.webp" \
    || fail "复制 spritesheet.webp 失败：$pet_id"
  verify_copy "$pet_source/pet.json" "$pet_stage/pet.json"
  verify_copy "$pet_source/spritesheet.webp" "$pet_stage/spritesheet.webp"

  if [ -d "$pet_destination" ]; then
    mkdir -p "$BACKUP_ROOT" || fail "无法创建备份目录：$BACKUP_ROOT"
    cp -R "$pet_destination" "$pet_backup" || fail "备份旧宠物失败：$pet_destination"
    diff -qr "$pet_destination" "$pet_backup" >/dev/null \
      || fail "旧宠物备份校验失败：$pet_id"
  fi

  rm -rf "$pet_destination"
  mv "$pet_stage" "$pet_destination" || fail "无法完成宠物安装：$pet_destination"
  [ -f "$pet_destination/pet.json" ] || fail "安装后缺少 pet.json：$pet_id"
  [ -f "$pet_destination/spritesheet.webp" ] \
    || fail "安装后缺少 spritesheet.webp：$pet_id"
  verify_copy "$pet_source/pet.json" "$pet_destination/pet.json"
  verify_copy "$pet_source/spritesheet.webp" "$pet_destination/spritesheet.webp"
  printf '[完成 / Installed] %s\n' "$pet_id"
}

printf '\n%s\n' '============================================================'
printf '%s\n' '  荒芜拉普兰德 Codex 宠物安装器'
printf '%s\n' '  Lappland the Decadenza Codex Pet Installer'
printf '%s\n' '============================================================'
printf '\n安装目录 / Install location:\n  %s\n\n' "$PETS_ROOT"

# Preflight both packages before changing the user's Codex directory.
validate_source "$PET_ONE"
validate_source "$PET_TWO"
mkdir -p "$PETS_ROOT" || fail "无法创建安装目录：$PETS_ROOT"

install_pet "$PET_ONE"
install_pet "$PET_TWO"

printf '\n%s\n' '============================================================'
printf '%s\n' '[成功 / Success] 两套宠物均已安装并通过 SHA-256 校验。'
printf '%s\n' '请彻底退出 Codex，再重新打开，然后前往“设置 → 外观 → 宠物”。'
printf '%s\n' 'Fully quit and reopen Codex, then choose the pet in Settings.'
if [ -d "$BACKUP_ROOT" ]; then
  printf '旧版本备份 / Backup: %s\n' "$BACKUP_ROOT"
fi
printf '%s\n\n' '============================================================'
