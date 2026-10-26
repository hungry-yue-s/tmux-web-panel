#!/usr/bin/bash
# sshd ForceCommand for a Windows host reached by another tmux-web-panel over
# SSH. Installed to /usr/local/bin/tmux-web-panel-ssh by
# `install-service.ps1 ssh-enable`; @LOGIN_SHELL@ and @SFTP_SERVER@ are filled
# in at install time.
#
# Windows OpenSSH starts the shell as `bash -lc <command>`, but for a session
# with a pty (`ssh -tt`) it pastes the command into that command line unquoted,
# so bash would run only its first word. ForceCommand is one word, and sshd
# hands the untouched command over in SSH_ORIGINAL_COMMAND for both modes.

case "${SSH_ORIGINAL_COMMAND-}" in
  '') exec @LOGIN_SHELL@ -l ;;
  # The subsystem arrives as "sftp-server.exe " (trailing space included).
  sftp-server.exe* | */sftp-server.exe* | *\\sftp-server.exe* | internal-sftp*)
    exec '@SFTP_SERVER@' ;;
esac
eval "$SSH_ORIGINAL_COMMAND"
