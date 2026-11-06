@echo off
rem OpenSSH runs this locally on Windows, where it cannot start ssh-askpass.sh
rem (CreateProcessW error 193). Never interpolate a password into a command.
if /i "%SSH_ASKPASS_PROMPT%"=="confirm" exit /b 1
"%TMUX_PANEL_NODE%" "%TMUX_PANEL_SSH_ASKPASS%"
