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

test('every command except create passes -N, so it can never start a tmux server', () => {
  for (const a of [L.listArgs('s'), L.attachArgs('s', 'a'), L.lookArgs('s', 'a', true), L.typeArgs('s', 'a', 'x'), L.enterArgs('s', 'a'), L.renameArgs('s', 'a', 'b'), L.killArgs('s', 'a')])
    assert.ok(a.includes('-N'), a.join(' '));
  assert.ok(!L.createArgs('s', 'a', '/tmp').includes('-N'));
});

test('the socket: -L <name> for a private server, nothing for the default server', () => {
  assert.deepEqual(L.killArgs('work', 'a'), ['-L', 'work', '-N', 'kill-session', '-t', '=a']);
  assert.deepEqual(L.killArgs('', 'a'), ['-N', 'kill-session', '-t', '=a']);
});

test('targets pin the exact session with "="', () => {
  assert.deepEqual(L.attachArgs('s', 'notes'), ['-L', 's', '-N', 'attach-session', '-t', '=notes']);
  assert.deepEqual(L.renameArgs('s', 'notes', 'notes2'), ['-L', 's', '-N', 'rename-session', '-t', '=notes', 'notes2']);
  assert.deepEqual(L.typeArgs('s', 'notes', 'claude --continue').slice(-3), ['=notes:', '-l', 'claude --continue']);
});

test('a bad session name is refused before it reaches tmux', () => {
  for (const bad of ['', 'a b', 'a:b', 'a.b', '-t x; rm', 'x'.repeat(49)]) {
    assert.throws(() => L.attachArgs('s', bad));
    assert.throws(() => L.killArgs('s', bad));
    assert.throws(() => L.renameArgs('s', 'ok', bad));
    assert.throws(() => L.createArgs('s', bad, '/tmp'));
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

test('parseSessions: reads the fields, skips odd names, sorts by name with numbers in order', () => {
  const out = ['$0\tweb-10\t0\tzsh\t/x/web\t0\t0', '$1\tweb-2\t1\t2.1.3\t/x/web\t995\t0', '$2\tbad name\t0\tzsh\t/x\t0\t0', 'x\tnoid\t0\tzsh\t/x\t0\t0', '$3\tapi\t0\tnode\t/x/api/\t0\t1', ''].join('\n');
  const s = L.parseSessions(out, 1000);
  assert.deepEqual(s.map(x => x.name), ['api', 'web-2', 'web-10']);
  assert.deepEqual(s[1], { id: '$1', name: 'web-2', attached: 1, command: 'claude', dir: '/x/web', state: 'working' });
  assert.equal(s[0].state, 'attention');
  assert.equal(L.describe(s[0]), 'node · api');
  assert.deepEqual(L.parseSessions('', 1000), []);
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
    assert.equal(spawnSync(tmux, L.listArgs(sock)).status !== 0, true, 'listing must not start a server');
    run(L.createArgs(sock, 'one', os.tmpdir())); run(L.createArgs(sock, 'one-more', os.tmpdir()));
    run(L.lookArgs(sock, 'one', true));
    assert.equal(run(['-L', sock, 'show-options', '-t', '=one:', '-v', 'status']).trim(), 'off');
    assert.notEqual(run(['-L', sock, 'show-options', '-t', '=one-more:', '-A', '-v', 'status']).trim(), 'off', 'the other session keeps its status line');
    run(L.typeArgs(sock, 'one', 'echo hi')); run(L.enterArgs(sock, 'one'));
    assert.deepEqual(L.parseSessions(run(L.listArgs(sock)), Date.now() / 1000).map(s => s.name), ['one', 'one-more']);
    const idBefore = L.parseSessions(run(L.listArgs(sock)), Date.now() / 1000).find(s => s.name === 'one').id;
    run(L.renameArgs(sock, 'one', 'renamed'));   // "=one" must not have matched "one-more"
    const after = L.parseSessions(run(L.listArgs(sock)), Date.now() / 1000);
    assert.deepEqual(after.map(s => s.name), ['one-more', 'renamed']);
    assert.equal(after.find(s => s.name === 'renamed').id, idBefore, 'a rename keeps the session id');
    run(L.killArgs(sock, 'renamed'));
    assert.deepEqual(L.parseSessions(run(L.listArgs(sock)), Date.now() / 1000).map(s => s.name), ['one-more']);
  } finally { spawnSync(tmux, ['-L', sock, 'kill-server']); }
});
