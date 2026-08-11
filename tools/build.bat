@echo off
REM Builds SNAP Menu Builder.exe into dist\, so the tool can be handed to
REM someone who does not have Python. Run from this folder.

pip install -r requirements.txt pyinstaller || goto :error

pyinstaller --onefile --windowed --name "SNAP Menu Builder" ^
  --collect-all customtkinter ^
  menu_tool.py || goto :error

echo.
echo Built dist\SNAP Menu Builder.exe
goto :eof

:error
echo.
echo Build failed.
exit /b 1
