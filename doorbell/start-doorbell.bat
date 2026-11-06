@echo off
rem Starts the doorbell/alarm companion (keeps running; close the window to stop)
cd /d "%~dp0"
title Alarm doorbell
python bell.py
