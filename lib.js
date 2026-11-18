'use strict';
// Pure helpers for the extension: no vscode, no child processes, so they can be unit-tested with plain Node.
// Everything that reaches tmux is built here as an argument array. Nothing is ever a shell string.

/** Session names this extension shows and creates. tmux itself forbids "." and ":" in names. */
const NAME = /^[A-Za-z0-9_-]{1,48}$/;
/** A session counts as "working" when it printed something in the last few seconds. */
const WORKING_SECONDS = 10;
const DEFAULT_SOCKET = 'vscode';
// session_id ("$3") is tmux's own number for a session. It never changes, also not when the session is renamed.
const FIELDS = ['#{session_id}', '#{session_name}', '#{session_attached}', '#{pane_current_command}', '#{pane_current_path}', '#{window_activity}', '#{window_bell_flag}'];

/** What "New session" offers when the user has set nothing. `command` is typed into the new session ('' = plain shell). */
const DEFAULT_COMMANDS = [
  { label: 'Shell', command: '' },
  { label: 'Claude', command: 'claude' },
  { label: 'Claude (continue last conversation)', command: 'claude --continue' },
];

/** The socket to use: a simple name selects a private tmux server (`tmux -L <name>`); '' means the user's default server. */
function socketName(setting) {
  if (setting === '') return '';
  return typeof setting === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(setting) ? setting : DEFAULT_SOCKET;
}
const base = socket => (socket ? ['-L', socket] : []);

/** The "New session" choices from the user's setting; anything malformed is dropped, and an empty result falls back to the defaults. */
function commandsFrom(setting) {
  if (!Array.isArray(setting)) return DEFAULT_COMMANDS;
  const out = [];
  for (const c of setting) {
    if (!c || typeof c !== 'object' || typeof c.label !== 'string' || typeof c.command !== 'string') continue;
    const label = c.label.trim().slice(0, 60), command = c.command.trim();
    if (!label || command.length > 500 || /[\x00-\x1f\x7f]/.test(command)) continue;   // one line only: it is typed, then Enter
    out.push({ label, command });
  }
  return out.length ? out.slice(0, 20) : DEFAULT_COMMANDS;
}

/** Some tools name their process after their version (Claude Code shows as "2.1.3"); show the tool's name instead. */
const commandName = c => (/^\d+\.\d+\.\d+$/.test(c) ? 'claude' : c);

/** The dot a session shows: a bell is 'attention', output in the last few seconds is 'working', otherwise 'quiet'. */
const stateOf = (bell, windowActivity, nowSec) =>
  bell === '1' ? 'attention'
  : Number.isFinite(windowActivity) && nowSec - windowActivity <= WORKING_SECONDS ? 'working'
  : 'quiet';

/** Parse `tmux list-sessions` output (see listArgs) into sessions sorted by name. Odd names are skipped. */
function parseSessions(out, nowSec) {
  const sessions = [];
  for (const line of String(out).split('\n')) {
    if (!line) continue;
    const [id = '', name = '', attached = '0', command = '', dir = '', winAct = '', bell = ''] = line.split('\t');
    if (!/^\$\d+$/.test(id) || !NAME.test(name)) continue;
    const wa = winAct.trim() === '' ? NaN : Number(winAct);
    sessions.push({ id, name, attached: Number(attached) || 0, command: commandName(command), dir, state: stateOf(bell, wa, nowSec) });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** The grey text after a session's name: what runs in it and the folder it is in. */
const describe = s => [s.command, s.dir.replace(/\/+$/, '').replace(/^.*\//, '')].filter(Boolean).join(' · ');

/** A session name from a folder path: its last part, odd characters turned to dashes. */
function cleanName(folder) {
  const last = String(folder || '').replace(/\/+$/, '').split('/').pop() || '';
  const slug = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return slug || 'session';
}

/** A name not already taken, adding -2, -3, ... and staying within the length limit. */
function uniqueName(wanted, existing) {
  const taken = new Set(existing || []);
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n++) {
    const suffix = '-' + n, name = wanted.slice(0, 48 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
  return wanted.slice(0, 40) + '-' + Date.now().toString(36).slice(-6);
}

const checked = name => { if (!NAME.test(name)) throw new Error('bad session name'); return name; };

// -N: never start a tmux server as a side effect. Only createArgs may start one, because the first session needs it.
const listArgs = socket => [...base(socket), '-N', 'list-sessions', '-F', FIELDS.join('\t')];
// The "=" pins the exact session name; without it tmux would also match a name that merely starts the same.
const attachArgs = (socket, name) => [...base(socket), '-N', 'attach-session', '-t', '=' + checked(name)];
// The folder is deliberately NOT an argument: tmux expands "#{...}" and "#(command)" in `new-session -c`, so a folder
// name could be read as a format. The caller runs this with the folder as its working directory, which tmux uses as is.
const createArgs = (socket, name) => [...base(socket), 'new-session', '-d', '-s', checked(name)];
/** Per-session look, never global: VS Code already shows the name on the tab, and the mouse wheel should scroll the history. */
const lookArgs = (socket, name, hideStatus) => [...base(socket), '-N', 'set-option', '-t', '=' + checked(name) + ':', 'mouse', 'on',
  ...(hideStatus ? [';', 'set-option', '-t', '=' + name + ':', 'status', 'off'] : [])];
const typeArgs = (socket, name, text) => [...base(socket), '-N', 'send-keys', '-t', '=' + checked(name) + ':', '-l', text];
const enterArgs = (socket, name) => [...base(socket), '-N', 'send-keys', '-t', '=' + checked(name) + ':', 'Enter'];
const renameArgs = (socket, name, to) => [...base(socket), '-N', 'rename-session', '-t', '=' + checked(name), checked(to)];
const killArgs = (socket, name) => [...base(socket), '-N', 'kill-session', '-t', '=' + checked(name)];

/** The tmux program: the user's own setting if it is an existing absolute path, else the usual install places, else PATH. */
function pickTmux(userSetting, exists) {
  if (typeof userSetting === 'string' && userSetting.startsWith('/') && exists(userSetting)) return userSetting;
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux', '/home/linuxbrew/.linuxbrew/bin/tmux'].find(exists) || 'tmux';
}

module.exports = { NAME, WORKING_SECONDS, DEFAULT_SOCKET, DEFAULT_COMMANDS, socketName, commandsFrom, commandName, stateOf, parseSessions, describe,
  cleanName, uniqueName, listArgs, attachArgs, createArgs, lookArgs, typeArgs, enterArgs, renameArgs, killArgs, pickTmux };
