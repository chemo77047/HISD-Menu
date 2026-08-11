@echo off
REM Double-click to open SNAP Menu Builder. Installs what it needs the first time.

python -m pip install --quiet --disable-pip-version-check -r "%~dp0requirements.txt" || goto :nopython
python "%~dp0menu_tool.py"
goto :eof

:nopython
echo.
echo Python could not be found or the install failed.
echo Install Python from https://www.python.org/downloads/ - tick "Add Python to PATH"
echo during the install - then double-click this file again.
pause
