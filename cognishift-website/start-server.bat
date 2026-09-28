@echo off
title CognitiveShift Local Server
echo ========================================================
echo   Starting CognitiveShift Web Server on http://localhost:8080
echo ========================================================
echo.
start "" "http://localhost:8080"
python -m http.server 8080
pause
