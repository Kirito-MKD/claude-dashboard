'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { tmpDir } = require('./helpers');
const { openDb } = require('../db');

// Схема первой версии дашборда — такие базы уже есть у пользователей
const V0 = `
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]', status TEXT, session_id TEXT,
  source TEXT NOT NULL DEFAULT 'agent', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  audio_path TEXT, images TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), done_at TEXT);
INSERT INTO tasks (project, task, summary, files, status) VALUES ('Gorshok', 'Резисторы', '**Итог**', '["a.md"]', 'Почти готово');
INSERT INTO notes (project, text, status, done_at) VALUES ('Gorshok', 'старая правка', 'done', '2026-09-30T10:00:00.000Z');
INSERT INTO notes (project, text) VALUES ('Gorshok', 'открытая правка');
`;

test('миграция базы первой версии: данные на месте, новые поля добавлены, повторное открытие безопасно', () => {
  const dir = tmpDir();
  const raw = new Database(path.join(dir, 'dashboard.db'));
  raw.exec(V0);
  raw.close();

  let db = openDb(dir);
  const [task] = db.listTasks({ project: 'Gorshok' });
  assert.equal(task.task, 'Резисторы');
  assert.equal(task.stage, null);
  const notes = db.listNotes({ project: 'Gorshok' });
  assert.equal(notes.length, 2);
  assert.equal(notes.find((n) => n.status === 'done').done_by, null, 'кто закрыл старые правки — неизвестно');
  const [project] = db.listProjects();
  assert.equal(project.name, 'Gorshok');
  assert.equal(project.pinned, false);
  assert.equal(project.archived, false);
  assert.equal(project.progress, null);
  assert.equal(db.raw.pragma('user_version', { simple: true }), 2);
  assert.equal(project.plan_skipped, false);
  db.close();

  db = openDb(dir);
  assert.equal(db.listTasks().length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
