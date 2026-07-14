@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>nul
title 荒芜拉普兰德 Codex 宠物安装器

set "PET_ONE=lappland-decadenza"
set "PET_TWO=lappland-decadenza-unruly-humbleness"
set "SCRIPT_DIR=%~dp0"
set "SOURCE_ROOT=%SCRIPT_DIR%pets"

if defined CODEX_HOME (
  set "TARGET_HOME=%CODEX_HOME%"
) else (
  set "TARGET_HOME=%USERPROFILE%\.codex"
)
set "PETS_ROOT=%TARGET_HOME%\pets"

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Date -Format 'yyyyMMdd-HHmmssfff'" 2^>nul`) do set "INSTALL_STAMP=%%I"
if not defined INSTALL_STAMP set "INSTALL_STAMP=unknown-%RANDOM%-%RANDOM%"
set "BACKUP_ROOT=%TARGET_HOME%\pet-backups\%INSTALL_STAMP%"

echo.
echo ============================================================
echo   荒芜拉普兰德 Codex 宠物安装器
echo   Lappland the Decadenza Codex Pet Installer
echo ============================================================
echo.
echo 安装目录 / Install location:
echo   %PETS_ROOT%
echo.

call :validate_source "%SOURCE_ROOT%\%PET_ONE%" "%PET_ONE%"
if errorlevel 1 goto :failed
call :validate_source "%SOURCE_ROOT%\%PET_TWO%" "%PET_TWO%"
if errorlevel 1 goto :failed

if not exist "%PETS_ROOT%\" mkdir "%PETS_ROOT%" >nul 2>nul
if not exist "%PETS_ROOT%\" (
  echo [错误 / Error] 无法创建安装目录："%PETS_ROOT%"
  echo 请确认当前账户对此目录有写入权限。
  goto :failed
)

call :install_pet "%PET_ONE%"
if errorlevel 1 goto :failed
call :install_pet "%PET_TWO%"
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo [成功 / Success] 两套宠物均已安装并通过 SHA-256 校验。
echo 请彻底退出 Codex，再重新打开，然后前往“设置 → 外观 → 宠物”。
echo Fully quit and reopen Codex, then choose the pet in Settings.
echo.
if exist "%BACKUP_ROOT%\" echo 旧版本备份 / Backup: %BACKUP_ROOT%
echo ============================================================
echo.
call :maybe_pause
exit /b 0

:validate_source
setlocal
set "PET_SOURCE=%~1"
set "PET_ID=%~2"
if not exist "%PET_SOURCE%\" (
  echo [错误 / Error] 安装包不完整，缺少目录：pets\%PET_ID%
  endlocal & exit /b 1
)
if not exist "%PET_SOURCE%\pet.json" (
  echo [错误 / Error] 安装包不完整，缺少：pets\%PET_ID%\pet.json
  endlocal & exit /b 1
)
if not exist "%PET_SOURCE%\spritesheet.webp" (
  echo [错误 / Error] 安装包不完整，缺少：pets\%PET_ID%\spritesheet.webp
  endlocal & exit /b 1
)
endlocal & exit /b 0

:install_pet
setlocal
set "PET_ID=%~1"
set "PET_SOURCE=%SOURCE_ROOT%\%~1"
set "PET_DESTINATION=%PETS_ROOT%\%~1"
set "PET_BACKUP=%BACKUP_ROOT%\%~1"
set "PET_STAGE=%PETS_ROOT%\.%~1.installing-%RANDOM%-%RANDOM%"

if exist "%PET_STAGE%\" rmdir /s /q "%PET_STAGE%" >nul 2>nul
mkdir "%PET_STAGE%" >nul 2>nul
if not exist "%PET_STAGE%\" (
  echo [错误 / Error] 无法创建临时安装目录："%PET_STAGE%"
  endlocal & exit /b 1
)

copy /y "%PET_SOURCE%\pet.json" "%PET_STAGE%\pet.json" >nul
if errorlevel 1 goto :install_copy_failed
copy /y "%PET_SOURCE%\spritesheet.webp" "%PET_STAGE%\spritesheet.webp" >nul
if errorlevel 1 goto :install_copy_failed

call :verify_hash "%PET_SOURCE%\pet.json" "%PET_STAGE%\pet.json"
if errorlevel 1 goto :install_verify_failed
call :verify_hash "%PET_SOURCE%\spritesheet.webp" "%PET_STAGE%\spritesheet.webp"
if errorlevel 1 goto :install_verify_failed

if exist "%PET_DESTINATION%" if not exist "%PET_DESTINATION%\" (
  echo [错误 / Error] 目标路径不是文件夹："%PET_DESTINATION%"
  goto :install_cleanup_failed
)

if exist "%PET_DESTINATION%\" (
  if not exist "%BACKUP_ROOT%\" mkdir "%BACKUP_ROOT%" >nul 2>nul
  if not exist "%BACKUP_ROOT%\" (
    echo [错误 / Error] 无法创建备份目录："%BACKUP_ROOT%"
    goto :install_cleanup_failed
  )
  robocopy "%PET_DESTINATION%" "%PET_BACKUP%" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 (
    echo [错误 / Error] 备份旧宠物失败："%PET_DESTINATION%"
    goto :install_cleanup_failed
  )
)

if exist "%PET_DESTINATION%\" rmdir /s /q "%PET_DESTINATION%" >nul 2>nul
if exist "%PET_DESTINATION%\" (
  echo [错误 / Error] 无法替换旧宠物目录："%PET_DESTINATION%"
  goto :install_cleanup_failed
)

move "%PET_STAGE%" "%PET_DESTINATION%" >nul
if errorlevel 1 (
  echo [错误 / Error] 无法完成宠物安装："%PET_DESTINATION%"
  goto :install_cleanup_failed
)

if not exist "%PET_DESTINATION%\pet.json" goto :install_missing_file
if not exist "%PET_DESTINATION%\spritesheet.webp" goto :install_missing_file
call :verify_hash "%PET_SOURCE%\pet.json" "%PET_DESTINATION%\pet.json"
if errorlevel 1 goto :install_verify_failed_after_move
call :verify_hash "%PET_SOURCE%\spritesheet.webp" "%PET_DESTINATION%\spritesheet.webp"
if errorlevel 1 goto :install_verify_failed_after_move

echo [完成 / Installed] %PET_ID%
endlocal & exit /b 0

:install_copy_failed
echo [错误 / Error] 复制宠物文件失败：%PET_ID%
goto :install_cleanup_failed

:install_verify_failed
echo [错误 / Error] 临时文件 SHA-256 校验失败：%PET_ID%
goto :install_cleanup_failed

:install_missing_file
echo [错误 / Error] 安装后文件不完整：%PET_ID%
endlocal & exit /b 1

:install_verify_failed_after_move
echo [错误 / Error] 安装后 SHA-256 校验失败：%PET_ID%
endlocal & exit /b 1

:install_cleanup_failed
if exist "%PET_STAGE%\" rmdir /s /q "%PET_STAGE%" >nul 2>nul
endlocal & exit /b 1

:verify_hash
setlocal
set "HASH_SOURCE=%~1"
set "HASH_DESTINATION=%~2"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $source=(Get-FileHash -LiteralPath $env:HASH_SOURCE -Algorithm SHA256).Hash; $destination=(Get-FileHash -LiteralPath $env:HASH_DESTINATION -Algorithm SHA256).Hash; if ($source -ne $destination) { exit 2 }" >nul 2>nul
if errorlevel 1 (
  endlocal & exit /b 1
)
endlocal & exit /b 0

:failed
echo.
echo ============================================================
echo [安装失败 / Installation failed]
echo 没有管理员权限也能安装；请检查 ZIP 是否完整，并先完整解压后再运行。
echo No administrator permission is required. Extract the whole ZIP and try again.
echo 如仍失败，请打开同目录的“安装说明.html”。
echo ============================================================
echo.
call :maybe_pause
exit /b 1

:maybe_pause
if not defined CODEX_PET_INSTALLER_NO_PAUSE pause
exit /b 0
