'use strict';
// Pure helpers for the extension: no vscode, no child processes, so they can be unit-tested with plain Node.
// Everything that reaches tmux is built here as an argument array. Nothing is ever a shell string.

/** Session names this extension shows and creates. tmux itself forbids "." and ":" in names. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;   // never a leading dash: tmux would read it as an option
/** A session counts as "working" when it printed something in the last few seconds. */
const WORKING_SECONDS = 10;
const DEFAULT_SOCKET = 'vscode';
// session_id ("$3") is tmux's own number for a session. It never changes, also not when the session is renamed.
// The two free-text fields (program and folder) come last, so odd characters in them cannot shift the others.
const FIELDS = ['#{session_id}', '#{session_name}', '#{session_attached}', '#{window_activity}', '#{window_bell_flag}', '#{pane_current_command}', '#{pane_current_path}'];

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
// -u: tmux output is UTF-8 whatever the locale (otherwise it prints the tab separators as "_" in a non-UTF-8 one).
// Deliberately no -N ("never start a server"): it only exists since tmux 3.2, and only new-session starts a server anyway.
const base = socket => ['-u', ...(socket ? ['-L', socket] : [])];

/** A random marker for one `list-sessions` call. Every real row starts with it, so text that a folder or program
 *  name smuggles into the output (a newline followed by a made-up row) is ignored: it cannot know the marker. */
const newToken = () => require('node:crypto').randomBytes(12).toString('hex');

/** The environment for tmux. The first session starts the tmux server, and every shell in it inherits the server's
 *  variables, so the editor's private ones (which change how programs started from that shell behave) are left out,
 *  as is any trace of an outer tmux. No locale is forced. */
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (v !== undefined && !/^(ELECTRON_|VSCODE_)/.test(k) && k !== 'TMUX' && k !== 'TMUX_PANE') out[k] = v;
  return out;
}

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

const plain = v => String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
/** Parse `tmux list-sessions` output (see listArgs) into sessions, oldest first: tmux numbers sessions as they are
 *  created, so the list keeps its order whatever is busy or renamed. Rows without this call's token are ignored;
 *  sessions that exist but have a name this extension does not handle are counted in `.hidden`. */
function parseSessions(out, nowSec, token) {
  const sessions = []; let hidden = 0;
  for (const line of String(out).split('\n')) {
    const [tok, id = '', name = '', attached = '0', winAct = '', bell = '', command = '', ...dir] = line.split('\t');
    if (!token || tok !== token || !/^\$\d+$/.test(id)) continue;
    if (!NAME.test(name)) { hidden++; continue; }
    const wa = winAct.trim() === '' ? NaN : Number(winAct);
    sessions.push({ id, name, attached: Number(attached) || 0, command: commandName(plain(command)), dir: plain(dir.join('\t')), state: stateOf(bell, wa, nowSec) });
  }
  sessions.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  sessions.hidden = hidden;
  return sessions;
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

// Only createArgs can start a tmux server (tmux starts one for new-session, and for no other command used here).
const listArgs = (socket, token) => [...base(socket), 'list-sessions', '-F', [token, ...FIELDS].join('\t')];
// The "=" pins the exact session name; without it tmux would also match a name that merely starts the same.
const attachArgs = (socket, name) => [...base(socket), 'attach-session', '-t', '=' + checked(name)];
// The folder is deliberately NOT an argument: tmux expands "#{...}" and "#(command)" in `new-session -c`, so a folder
// name could be read as a format. The caller runs this with the folder as its working directory, which tmux uses as is.
const createArgs = (socket, name) => [...base(socket), 'new-session', '-d', '-s', checked(name)];
/** Per-session look, never global: VS Code already shows the name on the tab, and the mouse wheel should scroll the history. */
const lookArgs = (socket, name, hideStatus) => [...base(socket), 'set-option', '-t', '=' + checked(name) + ':', 'mouse', 'on',
  ...(hideStatus ? [';', 'set-option', '-t', '=' + name + ':', 'status', 'off'] : [])];
// "--" so text starting with a dash is not read as an option; a trailing ";" is escaped because tmux would take it as
// its own command separator and drop it.
const typeArgs = (socket, name, text) => [...base(socket), 'send-keys', '-t', '=' + checked(name) + ':', '-l', '--', text.replace(/;$/, '\\;')];
const enterArgs = (socket, name) => [...base(socket), 'send-keys', '-t', '=' + checked(name) + ':', 'Enter'];
const renameArgs = (socket, name, to) => [...base(socket), 'rename-session', '-t', '=' + checked(name), '--', checked(to)];
const killArgs = (socket, name) => [...base(socket), 'kill-session', '-t', '=' + checked(name)];

/** The tmux program: the user's own setting if it is an existing absolute path, else the usual install places, else PATH. */
function pickTmux(userSetting, exists) {
  if (typeof userSetting === 'string' && userSetting.startsWith('/') && exists(userSetting)) return userSetting;
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux', '/home/linuxbrew/.linuxbrew/bin/tmux'].find(exists) || 'tmux';
}

module.exports = { newToken, cleanEnv, NAME, WORKING_SECONDS, DEFAULT_SOCKET, DEFAULT_COMMANDS, socketName, commandsFrom, commandName, stateOf, parseSessions, describe,
  cleanName, uniqueName, listArgs, attachArgs, createArgs, lookArgs, typeArgs, enterArgs, renameArgs, killArgs, pickTmux };
