# How it works

## The idea

tmux is a program that keeps terminal sessions alive in the background. A *tmux server* owns the sessions; a *client* is a window looking at one of them. Close the client and the session keeps running; open a new client and you are back where you were.

This extension is a thin layer on top of that:

```
 VS Code window                             tmux server (socket "vscode")
 ┌───────────────────────────┐              ┌──────────────────────────┐
 │ sidebar  ── list ─────────┼── tmux ────▶ │ session "api"   (shell,  │
 │                           │   list-      │                  agent)  │
 │ terminal tab "api" ═══════┼══ tmux ════▶ │ session "web"            │
 │   (this tab IS a tmux     │   attach     │ ...                      │
 │    client)                │              └──────────────────────────┘
 └───────────────────────────┘                 keeps running when the
                                               window on the left closes
```

- **The list** comes from `tmux list-sessions`, run every few seconds while the sidebar is visible, and every 30 seconds while it is hidden (only to keep the count on the icon right). Sessions are shown in the order they were created, which never changes, or by name if you choose that (`tmuxSessions.sortBy`, or the `...` menu of the list). Sorting by name puts numbers in order, so `api-9` comes before `api-10`.
- **A terminal tab** is not a shell that happens to run tmux. VS Code starts `tmux attach-session` directly as the tab's program. So closing the tab ends that tmux *client* only; the session and everything in it carries on.
- **Nothing is stored by the extension.** There is no database and no state file. tmux is the single source of truth, which is why the list is always right even if you also change things from a plain terminal.

## The private server

By default every command is run as `tmux -L vscode ...`. `-L` selects a separate tmux server with its own socket, so:

- the sessions here do not show up in your normal `tmux ls`, and yours do not show up here;
- your `~/.tmux.conf` still applies (tmux loads it for every server), but nothing the extension does can disturb your other sessions.

Set `tmuxSessions.socketName` to an empty string to use your default server instead and see your existing sessions in the list. From a plain terminal you reach the private server with `tmux -L vscode attach -t <name>`.

The server starts with the first session you create and exits when its last session ends. Only **New Session Here** can start one: tmux starts a server for `new-session` and for none of the other commands used here.

The server is started with a cleaned environment. Every shell in a session inherits the server's variables, so VS Code's private ones (`ELECTRON_*`, `VSCODE_*`) are left out: with them, programs you start from that shell could behave differently. No locale is forced either; your own applies.

## Creating a session

**New Session Here** runs, in order:

1. `tmux new-session -d -s <name>`, run *from* the open folder: a detached session there (your home folder if no folder is open; you are asked when several are open). The name is the folder's name, with `-2`, `-3`... added if taken.
2. `tmux set-option -t <name> mouse on` (and `status off` unless you turned `hideStatusLine` off). These are set **on that session only**, never globally. Mouse mode makes the wheel scroll tmux's history; the price is that dragging and clicking go to tmux, so hold Shift (Option on macOS) to select text or click a link the VS Code way. The status line is hidden because the tab already shows the name.
3. If you picked a command, it is *typed* into the session followed by Enter (`tmux send-keys -l`). It is typed rather than passed as the session's program on purpose: when the command exits you are left in a normal shell, and the session survives.
4. The session is opened as a terminal tab.

## The dots

For each session tmux reports when its window last produced output (`window_activity`) and whether a bell rang in it (`window_bell_flag`):

| Dot | Meaning | Rule |
|---|---|---|
| bell | wants attention | the bell flag is set (tmux sets it only while the session is not open in any terminal) |
| filled green | working | output within the last 10 seconds |
| hollow | quiet | neither |

The number on the sidebar icon is the count of sessions showing the bell.

## Renaming

A session has two identifiers in tmux: its **name**, which you see and can change, and its **id** (`$0`, `$1`, ...), a number tmux assigns once and never changes. The extension shows the name but remembers open terminal tabs by id. That is what makes renames safe.

When you choose **Rename Session...**:

1. You type the new name. It is checked against the allowed characters and against the current list (no duplicates).
2. `tmux rename-session -t =<old> <new>` runs. The `=` means "exactly this name": without it tmux would also accept a name that merely *starts* the same, and `api` could hit `api-2`.
3. The session itself is untouched: same id, same processes, same history. Only the label changed. Every client attached to it, in this window or any other, simply keeps going.
4. The terminal tab's title is updated to the new name. VS Code only offers "rename the active terminal", so the tab is brought to the front first and renamed once VS Code confirms it is active. If that fails, the tab keeps its old title until you reopen it; the session is renamed either way.
5. The list refreshes.

Renaming from outside works too. If you run `tmux -L vscode rename-session ...` in a terminal, the list shows the new name on its next refresh, and because tabs are tracked by id, clicking the renamed session brings its existing tab to the front instead of opening a second one. (That tab's title is not changed in this case: retitling it would mean stealing focus while you work.)

## Killing

**Kill Session...** asks for confirmation, then runs `tmux kill-session -t =<name>`. Everything running in the session stops and its terminal tab closes by itself, because the tmux client in it exits. Killing the last session also ends the private tmux server; the next **New Session Here** starts it again.

## Safety

- **No shell strings.** Every tmux call is an argument array passed straight to the program, so a session or folder name can never be interpreted as a command. All of them are built in `lib.js`, which has no other job and is unit-tested, including against a real tmux.
- **Folder names never reach tmux as text.** tmux treats `#{...}` and `#(command)` specially in some arguments, including the start folder of a new session. The folder is therefore passed as the working directory of the tmux command, not as an argument, so a folder with such a name is just a folder.
- **Names are validated** before they reach tmux, and names read back from tmux are validated again before they are shown or used. A name may not start with a dash, which tmux would read as an option.
- **The list cannot be forged.** A folder or program name is free text and ends up in tmux's output; one containing a line break could otherwise pose as an extra session. Every listing uses a fresh random marker at the start of each real row, and rows without it are ignored.
- **Settings that choose what runs** (`tmuxPath`, `socketName`, `newSessionCommands`) are read from your user settings only. Workspace settings are ignored for these, so opening someone's repository cannot plant a command.
- **No network, no telemetry, no files written.** The only program started is `tmux`.

## What happens when...

| Situation | Result |
|---|---|
| You close a terminal tab | tmux detaches. The session keeps running. |
| You reload or quit VS Code | Same. Reopen and click the session. Its tabs are not restored automatically, on purpose: they would come back as dead terminals. |
| The machine restarts | Sessions are gone; tmux does not survive a reboot. |
| Two VS Code windows open the same session | Both show it live and typing in one appears in the other. tmux uses one size for both, so one of the windows may not fit it exactly. |
| tmux is not installed | The sidebar says so, with install commands. |
