!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Kinuza.Magnet"
  DeleteRegKey HKCU "Software\Classes\Kinuza.Torrent"
  DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Kinuza.Torrent"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Kinuza"
  DeleteRegKey HKCU "Software\Kinuza\Capabilities"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
    StrCpy $R8 0
    kinuza_exit_wait:
      IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 kinuza_exit_done
      ClearErrors
      FileOpen $R9 "$INSTDIR\${MAINBINARYNAME}.exe" a
      IfErrors kinuza_exit_busy
      FileClose $R9
      Goto kinuza_exit_done
    kinuza_exit_busy:
      IntOp $R8 $R8 + 1
      IntCmp $R8 80 kinuza_exit_done 0 kinuza_exit_done
      Sleep 500
      Goto kinuza_exit_wait
    kinuza_exit_done:
  ${EndIf}
!macroend

