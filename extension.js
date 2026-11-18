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
// LC_ALL: without a UTF-8 locale tmux prints the tab separators of the list as "_".
const run = args => new Promise(resolve => execFile(tmuxPath(), args, { timeout: 8000, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } },
  (err, out, errOut) => resolve({ ok: !err, missing: !!err && err.code === 'ENOENT', out: String(out || ''), err: String(errOut || '') })));

class Sessions {
  constructor() { this.changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this.changed.event; this.items = []; }
  async refresh() {
    const r = await run(L.listArgs(socket()));   // fails when no server runs yet: that simply means no sessions
    this.items = r.ok ? L.parseSessions(r.out, Date.now() / 1000) : [];
    vscode.commands.executeCommand('setContext', 'tmuxSessions.state', r.missing ? 'notmux' : this.items.length ? 'ok' : 'empty');
    this.changed.fire();
  }
  getChildren() { return this.items; }
  getTreeItem(s) {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = s.name; item.contextValue = 'session'; item.description = L.describe(s);
    item.tooltip = `${s.name}\n${s.dir}\n${s.attached ? 'open in a terminal' : 'not open anywhere'} · ${s.state}`;
    const [icon, color] = ICON[s.state] || ICON.quiet;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.command = { command: 'tmuxSessions.open', title: 'Open', arguments: [s] };
    return item;
  }
}

function activate(context) {
  // Open terminals are remembered by tmux's session id, not by name: the id survives a rename, also one made outside VS Code.
  const sessions = new Sessions(), terminals = new Map();   // session id -> its VS Code terminal
  const view = vscode.window.createTreeView('tmuxSessions.list', { treeDataProvider: sessions });
  const refresh = async () => {
    await sessions.refresh();
    const n = sessions.items.filter(s => s.state === 'attention').length;   // a count on the sidebar icon, visible from any view
    view.badge = n ? { value: n, tooltip: `${n} session${n > 1 ? 's' : ''} rang the bell` } : undefined;
  };
  let timer = null;
  const poll = () => {   // refresh only while the list is on screen
    clearInterval(timer); timer = null;
    if (!view.visible) return;
    const every = Math.min(60, Math.max(2, Number(vscode.workspace.getConfiguration('tmuxSessions').get('refreshSeconds')) || 5));
    refresh(); timer = setInterval(refresh, every * 1000);
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

  function open(name) {
    const s = byName(name), old = s && terminals.get(s.id);
    if (old && old.exitStatus === undefined) return old.show();
    // The terminal is tmux itself, attached to the session: closing the tab detaches, the session keeps running.
    const t = vscode.window.createTerminal({ name, shellPath: tmuxPath(), shellArgs: L.attachArgs(socket(), name),
      iconPath: new vscode.ThemeIcon('terminal-tmux'), isTransient: true });   // transient: VS Code does not try to revive it after a restart
    if (s) terminals.set(s.id, t);
    t.show();
  }

  async function create() {
    const local = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file' && fs.existsSync(f.uri.fsPath));
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
    const made = await run(L.createArgs(socket(), name, where));
    if (!made.ok) return void vscode.window.showErrorMessage(made.missing ? 'tmux was not found. Install tmux, or set "tmuxSessions.tmuxPath".' : `Could not start a session: ${made.err.trim() || 'tmux refused.'}`);
    await run(L.lookArgs(socket(), name, vscode.workspace.getConfiguration('tmuxSessions').get('hideStatusLine') !== false));
    if (kind.command) { await run(L.typeArgs(socket(), name, kind.command)); await run(L.enterArgs(socket(), name)); }
    await refresh(); open(name);
  }

  async function rename(s) {
    const name = await pickSession(s, 'Rename which session?'); if (!name) return;
    const to = await vscode.window.showInputBox({ value: name, valueSelection: [0, name.length], prompt: `Rename "${name}"`,
      validateInput: v => (!v ? 'Enter a name' : !L.NAME.test(v) ? 'Use letters, numbers, dashes and underscores (48 at most).' : undefined) });
    if (!to || to === name) return;
    await refresh();
    if (sessions.items.some(x => x.name === to)) return void vscode.window.showErrorMessage(`There is already a session called ${to}.`);
    const r = await run(L.renameArgs(socket(), name, to));
    if (!r.ok) return void vscode.window.showErrorMessage(`Could not rename: ${r.err.trim() || 'tmux refused.'}`);
    // The open terminal tab is renamed too. VS Code can only rename the active terminal, so the tab is brought to the
    // front first, and left alone if that did not work (it then keeps its old title until reopened).
    const s0 = byName(name), t = s0 && terminals.get(s0.id);
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
    vscode.window.onDidChangeWindowState(w => { if (w.focused && view.visible) refresh(); }),
    vscode.window.onDidCloseTerminal(t => { for (const [id, x] of terminals) if (x === t) terminals.delete(id); refresh(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tmuxSessions')) poll(); }),
    vscode.commands.registerCommand('tmuxSessions.refresh', refresh),
    vscode.commands.registerCommand('tmuxSessions.new', create),
    vscode.commands.registerCommand('tmuxSessions.open', async s => { const n = await pickSession(s, 'Open which session?'); if (n) open(n); }),
    vscode.commands.registerCommand('tmuxSessions.rename', rename),
    vscode.commands.registerCommand('tmuxSessions.kill', kill));
  poll();
}
function deactivate() {}
module.exports = { activate, deactivate };
