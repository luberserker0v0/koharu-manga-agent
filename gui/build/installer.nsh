LangString uninstallUserDataSection 1033 "Delete Koharu Manga Agent settings, local backend data, and GUI-managed Koharu"
LangString uninstallUserDataDeleting 1033 "Deleting Koharu Manga Agent user data..."
LangString uninstallAllDataSection 1033 "Permanently delete ALL local app data, Koharu projects/models, and Docker backend data"
LangString uninstallAllDataDeleting 1033 "Permanently deleting all local Koharu Manga Agent data..."
LangString uninstallUserDataSection 1028 "刪除 Koharu Manga Agent 設定、本機 backend 資料與 GUI 管理的 Koharu"
LangString uninstallUserDataDeleting 1028 "正在刪除 Koharu Manga Agent 使用者資料..."
LangString uninstallAllDataSection 1028 "永久刪除所有本機 APP 資料、Koharu 專案／模型與 Docker backend 資料"
LangString uninstallAllDataDeleting 1028 "正在永久刪除所有本機 Koharu Manga Agent 資料..."

!macro customUnInstallSection
  Section /o "$(uninstallUserDataSection)" UNSEC_USER_DATA
    DetailPrint "$(uninstallUserDataDeleting)"
    RMDir /r "$APPDATA\manga-translation-gui"
    RMDir /r "$APPDATA\Koharu Manga Agent"
    RMDir /r "$LOCALAPPDATA\Koharu Manga Agent"
  SectionEnd

  Section /o "$(uninstallAllDataSection)" UNSEC_ALL_DATA
    DetailPrint "$(uninstallAllDataDeleting)"
    RMDir /r "$APPDATA\manga-translation-gui"
    RMDir /r "$APPDATA\Koharu Manga Agent"
    RMDir /r "$LOCALAPPDATA\Koharu Manga Agent"
    RMDir /r "$LOCALAPPDATA\Koharu"
    nsExec::ExecToLog '"docker.exe" rm -f manga-backend-backend-1'
    nsExec::ExecToLog '"docker.exe" volume rm -f manga-backend_backend-data'
  SectionEnd
!macroend
