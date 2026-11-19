# Changelog

## 0.3.0

- The list can be sorted by name instead of by creation: the `...` menu of the list, or the `tmuxSessions.sortBy` setting.

## 0.2.0

Found in a second review (code, QA and security):

- Works with tmux older than 3.2: the `-N` flag, which those versions do not have, is no longer used.
- **New Session Here** uses the open folder in Remote-SSH, WSL and container windows (it used to fall back to the home folder).
- The tmux server no longer inherits VS Code's private environment variables or a forced locale.
- The list is in order of creation and no longer reshuffles; it cannot be forged by a folder or program name containing line breaks.
- The count on the sidebar icon keeps updating while the sidebar is hidden.
- A command that starts with a dash or ends with `;` is typed correctly; names starting with a dash are refused.
- A real tmux error is shown instead of an empty list; sessions hidden because of their name are counted.
- Renaming keeps the right tab even if the list refreshes at the same moment; open tabs are tracked per tmux server.

## 0.1.1

Security: the folder of a new session is no longer passed to tmux as an argument, where a folder name containing `#{...}` or `#(...)` would have been read as a tmux format. Update from 0.1.0.

## 0.1.0

First release: session list with activity dots and an attention count, open as a terminal, new session in the open folder with a configurable command, rename, kill, private tmux server by default.
