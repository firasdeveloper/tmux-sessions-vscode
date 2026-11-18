# Changelog

## 0.1.1

Security: the folder of a new session is no longer passed to tmux as an argument, where a folder name containing `#{...}` or `#(...)` would have been read as a tmux format. Update from 0.1.0.

## 0.1.0

First release: session list with activity dots and an attention count, open as a terminal, new session in the open folder with a configurable command, rename, kill, private tmux server by default.
