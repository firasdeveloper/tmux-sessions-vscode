'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const L = require('../lib.js');

test('socketName: a simple name is a private server, empty is the default server, anything odd falls back', () => {
  assert.equal(L.socketName('work'), 'work');
  assert.equal(L.socketName(''), '');
  assert.equal(L.socketName(undefined), 'vscode');
  assert.equal(L.socketName('../x'), 'vscode');
  assert.equal(L.socketName(7), 'vscode');
});

test('no command uses -N (tmux only has it since 3.2), and every one passes -u so the output does not depend on the locale', () => {
  for (const a of [L.listArgs('s', 'tok'), L.attachArgs('s', 'a'), L.createArgs('s', 'a'), L.lookArgs('s', 'a', true), L.typeArgs('s', 'a', 'x'), L.enterArgs('s', 'a'), L.renameArgs('s', 'a', 'b'), L.killArgs('s', 'a')]) {
    assert.ok(!a.includes('-N'), a.join(' ')); assert.equal(a[0], '-u', a.join(' '));
  }
});

test('the socket: -L <name> for a private server, nothing for the default server', () => {
  assert.deepEqual(L.killArgs('work', 'a'), ['-u', '-L', 'work', 'kill-session', '-t', '=a']);
  assert.deepEqual(L.killArgs('', 'a'), ['-u', 'kill-session', '-t', '=a']);
});

test('targets pin the exact session with "="', () => {
  assert.deepEqual(L.attachArgs('s', 'notes'), ['-u', '-L', 's', 'attach-session', '-t', '=notes']);
  assert.deepEqual(L.renameArgs('s', 'notes', 'notes2'), ['-u', '-L', 's', 'rename-session', '-t', '=notes', '--', 'notes2']);
  assert.deepEqual(L.typeArgs('s', 'notes', 'claude --continue').slice(-4), ['=notes:', '-l', '--', 'claude --continue']);
  assert.equal(L.typeArgs('s', 'notes', 'a; b;').pop(), 'a; b\\;', 'a trailing ; would be read by tmux as its own separator');
});

test('a bad session name is refused before it reaches tmux', () => {
  for (const bad of ['', 'a b', 'a:b', 'a.b', '-t x; rm', '-x', '-', 'x'.repeat(49)]) {
    assert.throws(() => L.attachArgs('s', bad));
    assert.throws(() => L.killArgs('s', bad));
    assert.throws(() => L.renameArgs('s', 'ok', bad));
    assert.throws(() => L.createArgs('s', bad));
  }
});

test('lookArgs changes only that session, never global options', () => {
  const a = L.lookArgs('s', 'notes', true);
  assert.ok(!a.includes('-g'));
  assert.deepEqual(a.slice(-5), ['set-option', '-t', '=notes:', 'status', 'off']);
  assert.ok(!L.lookArgs('s', 'notes', false).includes('status'));
});

test('stateOf: a bell is attention, recent output is working, otherwise quiet', () => {
  assert.equal(L.stateOf('1', 1000, 1000), 'attention');
  assert.equal(L.stateOf('0', 995, 1000), 'working');
  assert.equal(L.stateOf('0', 980, 1000), 'quiet');
  assert.equal(L.stateOf('0', NaN, 1000), 'quiet');
});

test('parseSessions: reads the fields, skips odd names, keeps the order of creation (so the list never reshuffles)', () => {
  const out = ['T\t$10\tweb-10\t0\t0\t0\tzsh\t/x/web', 'T\t$9\tweb-2\t1\t995\t0\t2.1.3\t/x/web', 'T\t$2\tbad name\t0\t0\t0\tzsh\t/x', 'T\tx\tnoid\t0\t0\t0\tzsh\t/x', 'T\t$3\tapi\t0\t0\t1\tnode\t/x/api/', ''].join('\n');
  const s = L.parseSessions(out, 1000, 'T');
  assert.equal(s.hidden, 1, 'a session that exists but cannot be shown is counted');
  assert.deepEqual(s.map(x => x.name), ['api', 'web-2', 'web-10']);   // ids $3, $9, $10: oldest first, numerically
  assert.deepEqual(s[1], { id: '$9', name: 'web-2', attached: 1, command: 'claude', dir: '/x/web', state: 'working' });
  assert.equal(s[0].state, 'attention');
  assert.equal(L.describe(s[0]), 'node · api');
  assert.deepEqual(L.parseSessions(out, 1000, 'T', 'name').map(x => x.name), ['api', 'web-2', 'web-10']);
  const mixed = ['T\t$1\tzeta\t0\t0\t0\tzsh\t/x', 'T\t$2\talpha-10\t0\t0\t0\tzsh\t/x', 'T\t$3\talpha-9\t0\t0\t0\tzsh\t/x'].join('\n');
  assert.deepEqual(L.parseSessions(mixed, 1000, 'T').map(x => x.name), ['zeta', 'alpha-10', 'alpha-9'], 'default: as created');
  assert.deepEqual(L.parseSessions(mixed, 1000, 'T', 'name').map(x => x.name), ['alpha-9', 'alpha-10', 'zeta'], 'by name, numbers in order');
  assert.deepEqual([L.sortBy('name'), L.sortBy('created'), L.sortBy('x'), L.sortBy(undefined)], ['name', 'created', 'created', 'created']);
  assert.deepEqual([...L.parseSessions('', 1000, 'T')], []);
});

test('cleanName and uniqueName', () => {
  assert.equal(L.cleanName('/Users/x/My Project/'), 'my-project');
  assert.equal(L.cleanName('/'), 'session');
  assert.ok(L.NAME.test(L.cleanName('/x/A..Weird__Name!!')));
  assert.equal(L.uniqueName('notes', ['a']), 'notes');
  assert.equal(L.uniqueName('notes', ['notes', 'notes-2']), 'notes-3');
  assert.ok(L.uniqueName('x'.repeat(48), ['x'.repeat(48)]).length <= 48);
});

test('commandsFrom: the user list when valid, the defaults otherwise; multi-line or malformed entries are dropped', () => {
  assert.equal(L.commandsFrom(undefined), L.DEFAULT_COMMANDS);
  assert.equal(L.commandsFrom([]), L.DEFAULT_COMMANDS);
  assert.equal(L.commandsFrom([{ label: 'x' }, 'nope', { label: 'two lines', command: 'a\nb' }]), L.DEFAULT_COMMANDS);
  assert.deepEqual(L.commandsFrom([{ label: ' Copilot ', command: ' copilot ' }, { label: 'Shell', command: '' }, { label: '', command: 'x' }]),
    [{ label: 'Copilot', command: 'copilot' }, { label: 'Shell', command: '' }]);
});

test('pickTmux: the user path when it exists, else a usual place, else PATH', () => {
  assert.equal(L.pickTmux('/my/tmux', p => p === '/my/tmux'), '/my/tmux');
  assert.equal(L.pickTmux('relative/tmux', () => true), '/opt/homebrew/bin/tmux');
  assert.equal(L.pickTmux('/gone', p => p === '/usr/bin/tmux'), '/usr/bin/tmux');
  assert.equal(L.pickTmux(undefined, () => false), 'tmux');
});

// The argument arrays against a real tmux, on a throwaway server that is removed afterwards.
const tmux = L.pickTmux(undefined, p => spawnSync(p, ['-V']).status === 0);
const haveTmux = spawnSync(tmux, ['-V']).status === 0;
test('against real tmux: create, look, list, type, rename, kill', { skip: !haveTmux && 'tmux is not installed' }, () => {
  const sock = 'tsv-test-' + process.pid, run = args => execFileSync(tmux, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  try {
    assert.equal(spawnSync(tmux, L.listArgs(sock, 'tk')).status !== 0, true); assert.notEqual(spawnSync(tmux, ['-L', sock, 'has-session']).status, 0, 'listing must not start a server');
    run(L.createArgs(sock, 'one')); run(L.createArgs(sock, 'one-more'));
    run(L.lookArgs(sock, 'one', true));
    assert.equal(run(['-L', sock, 'show-options', '-t', '=one:', '-v', 'status']).trim(), 'off');
    assert.notEqual(run(['-L', sock, 'show-options', '-t', '=one-more:', '-A', '-v', 'status']).trim(), 'off', 'the other session keeps its status line');
    run(L.typeArgs(sock, 'one', '-dash --first; echo two;'));   // a leading dash and a trailing ; must both arrive as typed
    assert.ok(run(['-L', sock, 'capture-pane', '-p', '-t', '=one:']).includes('-dash --first; echo two;'));
    assert.deepEqual(L.parseSessions(run(L.listArgs(sock, 'tk')), Date.now() / 1000, 'tk').map(s => s.name), ['one', 'one-more']);
    const idBefore = L.parseSessions(run(L.listArgs(sock, 'tk')), Date.now() / 1000, 'tk').find(s => s.name === 'one').id;
    run(L.renameArgs(sock, 'one', 'renamed'));   // "=one" must not have matched "one-more"
    const after = L.parseSessions(run(L.listArgs(sock, 'tk')), Date.now() / 1000, 'tk');
    assert.deepEqual(after.map(s => s.name), ['renamed', 'one-more'], 'a rename does not move the session in the list');
    assert.equal(after.find(s => s.name === 'renamed').id, idBefore, 'a rename keeps the session id');
    run(L.killArgs(sock, 'renamed'));
    assert.deepEqual(L.parseSessions(run(L.listArgs(sock, 'tk')), Date.now() / 1000, 'tk').map(s => s.name), ['one-more']);
  } finally { spawnSync(tmux, ['-L', sock, 'kill-server']); }
});

// tmux expands "#{...}" and runs "#(...)" in the folder given to `new-session -c`. A folder name must never get there:
// the folder is handed over as the working directory of the tmux command instead.
test('against real tmux: a folder name with tmux format characters is taken literally and runs nothing', { skip: !haveTmux && 'tmux is not installed' }, () => {
  const fs = require('node:fs'), path = require('node:path');
  const sock = 'tsv-fmt-' + process.pid, root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tsv-'));
  const folder = path.join(root, 'odd #(touch ran) #{session_name}'); fs.mkdirSync(folder);   // the command would run in the server's folder
  try {
    const args = L.createArgs(sock, 'fmt');
    assert.ok(!args.includes('-c') && !args.some(a => a.includes('#')), 'no folder among the arguments');
    execFileSync(tmux, args, { cwd: folder, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
    const where = execFileSync(tmux, ['-L', sock, 'display-message', '-p', '-t', '=fmt:', '#{pane_current_path}'], { encoding: 'utf8' }).trim();
    assert.equal(where, folder, 'the session starts in exactly that folder');
    assert.equal(fs.existsSync(path.join(folder, 'ran')) || fs.existsSync(path.join(root, 'ran')), false, 'nothing from the folder name was run');
  } finally { spawnSync(tmux, ['-L', sock, 'kill-server']); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a folder or program name cannot forge rows in the list: only lines that start with this call\'s token count', () => {
  const tok = L.newToken(); assert.match(tok, /^[a-f0-9]{16,}$/); assert.notEqual(tok, L.newToken());
  // a real session whose folder name contains a newline and a made-up record, and one with a tab in its folder name
  const out = [`${tok}\t$0\treal\t0\t0\t0\tzsh\t/x/evil`, '$99\tforged\t0\t0\t1\tzsh\t/tmp', `nottok\t$98\talso-forged\t0\t0\t1\tzsh\t/tmp`, `${tok}\t$1\ttabby\t0\t0\t0\tzsh\t/x/tab\tdir`].join('\n');
  const s = L.parseSessions(out, 1000, tok);
  assert.deepEqual(s.map(x => x.name), ['real', 'tabby']);
  assert.equal(s[1].dir, '/x/tab dir', 'control characters are never shown');
  assert.ok(s.every(x => x.state === 'quiet'));
});

test('cleanEnv: the tmux server must not inherit the editor\'s private variables, and no locale is forced', () => {
  const e = L.cleanEnv({ PATH: '/bin', HOME: '/h', LANG: 'de_DE.UTF-8', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', VSCODE_PID: '1', VSCODE_IPC_HOOK: 'x', TMUX: '/tmp/x,1,0', TMUX_PANE: '%1' });
  assert.deepEqual(e, { PATH: '/bin', HOME: '/h', LANG: 'de_DE.UTF-8' });
});

test('against real tmux: with a server already running, a second session still starts in the given folder', { skip: !haveTmux && 'tmux is not installed' }, () => {
  const fs = require('node:fs'), path = require('node:path');
  const sock = 'tsv-cwd-' + process.pid, root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tsv-')), second = path.join(root, 'second'); fs.mkdirSync(second);
  try {
    execFileSync(tmux, L.createArgs(sock, 'a'), { cwd: root }); execFileSync(tmux, L.createArgs(sock, 'b'), { cwd: second });
    assert.equal(execFileSync(tmux, ['-L', sock, 'display-message', '-p', '-t', '=b:', '#{pane_current_path}'], { encoding: 'utf8' }).trim(), second);
  } finally { spawnSync(tmux, ['-L', sock, 'kill-server']); fs.rmSync(root, { recursive: true, force: true }); }
});
