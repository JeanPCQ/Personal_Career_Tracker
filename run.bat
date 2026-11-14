@echo off
rem Double-click to start Job Tracker. Keep this window open while you use it.
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python app.py
pause
