'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const INSTALL = path.join(__dirname, '..', 'scripts', 'install.js');
const ROOT = path.resolve(__dirname, '..').split(path.sep).join('/');

const run = (dir, ...args) => spawnSync(process.execPath, [INSTALL, '--claude-dir', dir, ...args], { encoding: 'utf8' });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dir, name) => fs.readdirSync(dir).filter((f) => f.startsWith(name + '.bak-'));

const EXISTING = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'], deny: [] },
  env: { FOO: 'bar' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '~/bin/other-start.sh' }] }],
  },
  statusLine: { type: 'command', command: 'echo hi' },
};

test('install: мержит хуки, не затирая чужие настройки; повторный запуск ничего не меняет', () => {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(EXISTING, null, 2));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Мои правила\n\nПиши тесты.\n');

  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const s = readJson(settingsFile);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, EXISTING.permissions);
  assert.deepEqual(s.env, EXISTING.env);
  assert.deepEqual(s.statusLine, EXISTING.statusLine);
  assert.deepEqual(s.hooks.PreToolUse, EXISTING.hooks.PreToolUse);
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.deepEqual(s.hooks.SessionStart[0], EXISTING.hooks.SessionStart[0], 'чужой SessionStart на месте');
  assert.deepEqual(s.hooks.SessionStart[1], { hooks: [{ type: 'command', command: `node "${ROOT}/hooks/session-start.js"`, timeout: 10 }] });
  assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: `node "${ROOT}/hooks/session-end.js"`, timeout: 5 }] }]);
  assert.equal(backups(dir, 'settings.json').length, 1);

  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith('# Мои правила\n\nПиши тесты.\n\n<!-- agent-dashboard:start -->'));
  assert.ok(md.includes('В конце каждой задачи отправь curl POST на localhost:4000/api/tasks с кратким summary и статусом проекта. Выполненные правки отметь через PATCH.'));

  const snapshot = fs.readFileSync(settingsFile, 'utf8');
  const r2 = run(dir);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /хуки уже настроены/);
  assert.match(r2.stdout, /инструкция уже на месте/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), snapshot);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), md);
  assert.equal(backups(dir, 'settings.json').length, 1, 'без изменений — без новых бэкапов');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install: старый путь к хукам заменяется на месте, а не дублируется', () => {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      SessionEnd: [{ hooks: [
        { type: 'command', command: 'node "/Users/old/agent-dashboard/hooks/session-end.js"', timeout: 3 },
        { type: 'command', command: 'echo bye' },
      ] }],
    },
  }));
  assert.equal(run(dir).status, 0);
  const s = readJson(settingsFile);
  assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [
    { type: 'command', command: `node "${ROOT}/hooks/session-end.js"`, timeout: 5 },
    { type: 'command', command: 'echo bye' },
  ] }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install: без settings.json и CLAUDE.md — создаёт их', () => {
  const dir = path.join(tmpDir(), 'fresh-claude');
  assert.equal(run(dir).status, 0);
  const s = readJson(path.join(dir, 'settings.json'));
  assert.deepEqual(Object.keys(s.hooks), ['SessionStart', 'SessionEnd']);
  assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').startsWith('<!-- agent-dashboard:start -->'));
});

test('install: битый settings.json не трогается, код ошибки 1', () => {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, '{ "model": "opus", // комментарий\n}');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /некорректный JSON/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ "model": "opus", // комментарий\n}');
  assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false, 'ничего не записано');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstall: убирает только своё', () => {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(EXISTING));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Мои правила\n');
  run(dir);
  const r = run(dir, '--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJson(settingsFile), EXISTING);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Мои правила\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--dry-run ничего не пишет', () => {
  const dir = tmpDir();
  const r = run(dir, '--dry-run');
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
