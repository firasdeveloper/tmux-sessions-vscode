'use strict';
// A smoke test inside a real VS Code (see test/host/run.sh): the extension activates, lists a session of a throwaway
// tmux server, and opens it as a terminal that tmux reports as attached. Dialog-driven commands (rename, kill, new) are
// covered by the unit tests of the tmux arguments; VS Code gives tests no way to answer another extension's dialogs.
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const L = require('../../lib.js');

exports.run = async function run() {
  const sock = process.env.TSV_SOCK, out = process.env.TSV_RESULT, tmux = L.pickTmux(undefined, p => fs.existsSync(p));
  const t = args => execFileSync(tmux, ['-L', sock, ...args], { encoding: 'utf8' }).trim();
  const wait = async (what, check) => { for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 250)); } throw new Error('timed out: ' + what); };
  const steps = [];
  try {
    await vscode.workspace.getConfiguration('tmuxSessions').update('socketName', sock, vscode.ConfigurationTarget.Global);
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'tmux-sessions'); if (!ext) throw new Error('extension not loaded');
    await ext.activate(); steps.push('activated');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['new', 'refresh', 'open', 'rename', 'kill']) if (!cmds.includes('tmuxSessions.' + c)) throw new Error('command missing: ' + c);
    steps.push('commands registered');
    await vscode.commands.executeCommand('tmuxSessions.refresh');
    await vscode.commands.executeCommand('tmuxSessions.open', { name: 'smoke' });
    await wait('terminal attached', () => t(['list-sessions', '-F', '#{session_name}:#{session_attached}']).split('\n').includes('smoke:1'));
    if (!vscode.window.terminals.some(x => x.name === 'smoke')) throw new Error('no terminal named after the session');
    steps.push('opened and attached');
    await vscode.commands.executeCommand('tmuxSessions.open', { name: 'smoke' });   // a second click reuses the tab
    await new Promise(r => setTimeout(r, 800));
    if (vscode.window.terminals.filter(x => x.name === 'smoke').length !== 1) throw new Error('a second click opened a second terminal');
    steps.push('second click reuses the tab');
    vscode.window.terminals.find(x => x.name === 'smoke').dispose();
    await wait('detached, session alive', () => t(['list-sessions', '-F', '#{session_name}:#{session_attached}']).split('\n').includes('smoke:0'));
    steps.push('closing the tab leaves the session running');
    fs.writeFileSync(out, 'PASS\n' + steps.join('\n') + '\n');
  } catch (e) { fs.writeFileSync(out, 'FAIL ' + (e && e.message) + '\n' + steps.join('\n') + '\n'); }
  finally { await vscode.commands.executeCommand('workbench.action.closeWindow'); }
};
