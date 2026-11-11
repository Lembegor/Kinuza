!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Kinuza.Magnet"
  DeleteRegKey HKCU "Software\Classes\Kinuza.Torrent"
  DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Kinuza.Torrent"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Kinuza"
  DeleteRegKey HKCU "Software\Kinuza\Capabilities"
!macroend
