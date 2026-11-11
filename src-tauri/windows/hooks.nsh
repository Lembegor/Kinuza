; Removes the magnet/.torrent registration that the app writes for the current user.
; The saved previous handlers (Software\Kinuza\PreviousHandlers) are kept: this hook also runs
; when an update replaces the app, and the app must still be able to restore them later.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Kinuza.Magnet"
  DeleteRegKey HKCU "Software\Classes\Kinuza.Torrent"
  DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Kinuza.Torrent"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Kinuza"
  DeleteRegKey HKCU "Software\Kinuza\Capabilities"
!macroend
