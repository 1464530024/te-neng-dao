; 特能导 · NSIS 自定义脚本
; 1) 安装时给出中文提示
; 2) 卸载时询问是否一并删除用户数据（历史记录、登录状态、设置）

!macro customInstall
  DetailPrint "正在安装 特能导 ..."
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除「特能导」的历史记录、登录状态与设置数据？$\r$\n$\r$\n选择「否」将保留数据，方便日后再装回来继续使用。" \
    /SD IDNO IDNO tnd_keep_data
    RMDir /r "$APPDATA\特能导"
    RMDir /r "$LOCALAPPDATA\特能导"
  tnd_keep_data:
!macroend
