'use strict';
// tmux Sessions: a sidebar that lists the sessions of a local tmux server, opens one as an ordinary VS Code terminal,
// and creates, renames and kills them. A session keeps running when its terminal tab, the window or VS Code closes.
// It talks only to the tmux program on this machine, always with argument arrays (never a shell string), and makes no
// network connection.
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const L = require('./lib.js');

const ICON = { attention: ['bell-dot', 'list.warningForeground'], working: ['circle-filled', 'testing.iconPassed'], quiet: ['circle-outline', 'descriptionForeground'] };

/** Settings that decide which program runs or what is typed into a shell are read from the user's own settings only:
 *  a folder you merely opened must not be able to choose them. */
const userSetting = key => { const i = vscode.workspace.getConfiguration('tmuxSessions').inspect(key); return i ? i.globalValue : undefined; };
const tmuxPath = () => L.pickTmux(userSetting('tmuxPath'), p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const socket = () => L.socketName(userSetting('socketName'));
// The environment is cleaned because the first session starts the tmux server, and every shell in it inherits these variables.
const run = (args, cwd) => new Promise(resolve => execFile(tmuxPath(), args, { timeout: 8000, cwd, env: L.cleanEnv(process.env) },
  (err, out, errOut) => resolve({ ok: !err, missing: !!err && err.code === 'ENOENT', out: String(out || ''), err: String(errOut || '') })));

class Sessions {
  constructor() { this.changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this.changed.event; this.items = []; }
  async refresh() {
    const token = L.newToken(), r = await run(L.listArgs(socket(), token));
    this.items = r.ok ? L.parseSessions(r.out, Date.now() / 1000, token, vscode.workspace.getConfiguration('tmuxSessions').get('sortBy')) : [];
    this.hidden = r.ok ? this.items.hidden : 0;
    // No server yet simply means no sessions. Any other failure is shown, not passed off as an empty list.
    const noServer = /no server running|error connecting|no sessions|No such file or directory/i.test(r.err);
    this.error = r.ok || r.missing || noServer ? '' : (r.err.trim().split('\n')[0] || 'tmux did not answer').slice(0, 200);
    vscode.commands.executeCommand('setContext', 'tmuxSessions.state', r.missing ? 'notmux' : this.items.length ? 'ok' : 'empty');
    this.changed.fire();
  }
  getChildren() { return this.items; }
  getTreeItem(s) {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = s.id; item.contextValue = 'session'; item.description = L.describe(s);
    item.tooltip = `${s.name}\n${s.dir}\n${s.attached ? 'open in a terminal' : 'not open anywhere'} · ${s.state}`;
    const [icon, color] = ICON[s.state] || ICON.quiet;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.command = { command: 'tmuxSessions.open', title: 'Open', arguments: [s] };
    return item;
  }
}

function activate(context) {
  // Open terminals are remembered by tmux's session id, not by name: the id survives a rename, also one made outside
  // VS Code. The socket is part of the key, because every tmux server numbers its sessions from $0.
  const sessions = new Sessions(), terminals = new Map();   // "<socket> <session id>" -> its VS Code terminal
  const keyOf = s => `${socket()} ${s.id}`;
  const view = vscode.window.createTreeView('tmuxSessions.list', { treeDataProvider: sessions });
  const refresh = async () => {
    await sessions.refresh();
    const n = sessions.items.filter(s => s.state === 'attention').length;   // a count on the sidebar icon
    view.badge = n ? { value: n, tooltip: `${n} session${n > 1 ? 's' : ''} rang the bell` } : undefined;
    const h = sessions.hidden;
    view.message = sessions.error ? `tmux: ${sessions.error}` : h ? `${h} session${h > 1 ? 's are' : ' is'} not shown (names with characters other than letters, numbers, - and _).` : undefined;
  };
  let timer = null;
  const poll = () => {   // often while the list is on screen; slowly while it is hidden, only to keep the count on the icon right
    clearInterval(timer);
    const every = Math.min(60, Math.max(2, Number(vscode.workspace.getConfiguration('tmuxSessions').get('refreshSeconds')) || 5));
    refresh(); timer = setInterval(refresh, (view.visible ? every : 30) * 1000);
  };
  // Commands get the session object from the list (a click or the right-click menu), or nothing from the Command Palette.
  const nameOf = s => { const n = s && typeof s === 'object' ? s.name : s; return typeof n === 'string' && L.NAME.test(n) ? n : null; };
  const pickSession = async (s, placeHolder) => {
    const given = nameOf(s); if (given) return given;
    await refresh();
    if (!sessions.items.length) { vscode.window.showInformationMessage('There are no tmux sessions.'); return null; }
    const p = await vscode.window.showQuickPick(sessions.items.map(x => ({ label: x.name, description: L.describe(x) })), { placeHolder });
    return p ? p.label : null;
  };

  const byName = name => sessions.items.find(x => x.name === name);
  /** Show a terminal and wait until VS Code reports it as the active one (commands such as "rename" act on the active terminal). */
  const focus = t => new Promise(resolve => {
    if (vscode.window.activeTerminal === t) { t.show(); return resolve(true); }
    const done = ok => { sub.dispose(); clearTimeout(timeout); resolve(ok); };
    const sub = vscode.window.onDidChangeActiveTerminal(a => { if (a === t) done(true); }), timeout = setTimeout(() => done(vscode.window.activeTerminal === t), 1500);
    t.show();
  });

  async function open(name) {
    let s = byName(name);
    if (!s) { await refresh(); s = byName(name); }   // the list may be a few seconds old
    if (!s) return void vscode.window.showWarningMessage(`The tmux session "${name}" no longer exists.`);
    const old = terminals.get(keyOf(s));
    if (old && old.exitStatus === undefined) return old.show();
    // The terminal is tmux itself, attached to the session: closing the tab detaches, the session keeps running.
    const t = vscode.window.createTerminal({ name, shellPath: tmuxPath(), shellArgs: L.attachArgs(socket(), name),
      iconPath: new vscode.ThemeIcon('terminal-tmux'), isTransient: true });   // transient: VS Code does not try to revive it after a restart
    terminals.set(keyOf(s), t); t.show();
  }

  async function create() {
    // Folders on the machine this extension runs on: a plain local folder, or the remote side of an SSH, WSL or container window.
    const local = (vscode.workspace.workspaceFolders || []).filter(f => (f.uri.scheme === 'file' || (vscode.env.remoteName && f.uri.scheme === 'vscode-remote')) && fs.existsSync(f.uri.fsPath));
    let where = local.length ? local[0].uri.fsPath : os.homedir();
    if (local.length > 1) {   // several folders open: ask which one
      const f = await vscode.window.showQuickPick(local.map(x => ({ label: x.name, description: x.uri.fsPath })), { placeHolder: 'Start the session in which folder?' });
      if (!f) return; where = f.description;
    }
    const kind = await vscode.window.showQuickPick(L.commandsFrom(userSetting('newSessionCommands')).map(c => ({ label: c.label, description: c.command, command: c.command })),
      { placeHolder: `New tmux session in ${where}` });
    if (!kind) return;
    await refresh();
    const name = L.uniqueName(L.cleanName(where), sessions.items.map(s => s.name));
    const made = await run(L.createArgs(socket(), name), where);   // the folder goes in as the working directory, never as an argument
    if (!made.ok) return void vscode.window.showErrorMessage(!fs.existsSync(where) ? `The folder ${where} no longer exists.`
      : made.missing ? 'tmux was not found. Install tmux, or set "tmuxSessions.tmuxPath".' : `Could not start a session: ${made.err.trim() || 'tmux refused.'}`);
    await run(L.lookArgs(socket(), name, vscode.workspace.getConfiguration('tmuxSessions').get('hideStatusLine') !== false));
    if (kind.command) {
      const typed = await run(L.typeArgs(socket(), name, kind.command));
      if (typed.ok) await run(L.enterArgs(socket(), name));
      else vscode.window.showWarningMessage(`The session was started, but "${kind.command}" could not be typed into it: ${typed.err.trim() || 'tmux refused.'}`);
    }
    await refresh(); await open(name);
  }

  async function rename(s) {
    const name = await pickSession(s, 'Rename which session?'); if (!name) return;
    const to = await vscode.window.showInputBox({ value: name, valueSelection: [0, name.length], prompt: `Rename "${name}"`,
      validateInput: v => (!v ? 'Enter a name' : !L.NAME.test(v) ? 'Use letters, numbers, dashes and underscores (48 at most).' : undefined) });
    if (!to || to === name) return;
    await refresh();
    if (sessions.items.some(x => x.name === to)) return void vscode.window.showErrorMessage(`There is already a session called ${to}.`);
    const before = byName(name), t = before && terminals.get(keyOf(before));   // found now: after the rename the list no longer has this name
    const r = await run(L.renameArgs(socket(), name, to));
    if (!r.ok) return void vscode.window.showErrorMessage(`Could not rename: ${r.err.trim() || 'tmux refused.'}`);
    // The open terminal tab is renamed too. VS Code can only rename the active terminal, so the tab is brought to the
    // front first, and left alone if that did not work (it then keeps its old title until reopened).
    if (t && t.exitStatus === undefined && await focus(t)) {
      try { await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: to }); } catch { /* the tab keeps its old title */ }
    }
    await refresh();
  }

  async function kill(s) {
    const name = await pickSession(s, 'Kill which session?'); if (!name) return;
    const yes = await vscode.window.showWarningMessage(`Kill the tmux session "${name}"? Everything running in it stops.`, { modal: true }, 'Kill');
    if (yes !== 'Kill') return;
    const r = await run(L.killArgs(socket(), name));
    if (!r.ok) vscode.window.showErrorMessage(`Could not kill ${name}: ${r.err.trim() || 'tmux refused.'}`);
    refresh();
  }

  context.subscriptions.push(view, { dispose: () => clearInterval(timer) },
    view.onDidChangeVisibility(poll),
    vscode.window.onDidChangeWindowState(w => { if (w.focused) refresh(); }),
    vscode.window.onDidCloseTerminal(t => { for (const [id, x] of terminals) if (x === t) terminals.delete(id); refresh(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tmuxSessions')) poll(); }),
    vscode.commands.registerCommand('tmuxSessions.refresh', refresh),
    vscode.commands.registerCommand('tmuxSessions.toggleSort', async () => {
      const cfg = vscode.workspace.getConfiguration('tmuxSessions');
      await cfg.update('sortBy', L.sortBy(cfg.get('sortBy')) === 'name' ? 'created' : 'name', vscode.ConfigurationTarget.Global); refresh();
    }),
    vscode.commands.registerCommand('tmuxSessions.new', create),
    vscode.commands.registerCommand('tmuxSessions.open', async s => { const n = await pickSession(s, 'Open which session?'); if (n) await open(n); }),
    vscode.commands.registerCommand('tmuxSessions.rename', rename),
    vscode.commands.registerCommand('tmuxSessions.kill', kill));
  poll();
}
function deactivate() {}
module.exports = { activate, deactivate };
