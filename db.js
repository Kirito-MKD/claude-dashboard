'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  task        TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  files       TEXT NOT NULL DEFAULT '[]',
  status      TEXT,
  session_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'agent',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  audio_path  TEXT,
  images      TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project, status, id DESC);
`;

function parseJsonArray(value) {
  try {
    const v = JSON.parse(value || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'dashboard.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(SCHEMA);

  const q = {
    insertTask: db.prepare(`INSERT INTO tasks (project, task, summary, files, status, session_id, source)
                            VALUES (@project, @task, @summary, @files, @status, @session_id, @source)`),
    // Хук SessionEnd может сработать несколько раз для одной сессии (resume → exit):
    // обновляем его запись, а не плодим дубли.
    findHookTask: db.prepare(`SELECT id FROM tasks WHERE session_id = ? AND source = 'hook' ORDER BY id DESC LIMIT 1`),
    updateHookTask: db.prepare(`UPDATE tasks SET project = @project, task = @task, summary = @summary, files = @files,
                                status = COALESCE(@status, status) WHERE id = @id`),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),

    insertNote: db.prepare(`INSERT INTO notes (project, text, audio_path, images)
                            VALUES (@project, @text, @audio_path, @images)`),
    getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

    projects: db.prepare(`
      WITH names AS (SELECT project FROM tasks UNION SELECT project FROM notes)
      SELECT n.project AS name,
             (SELECT COUNT(*) FROM tasks t WHERE t.project = n.project) AS tasks,
             (SELECT COUNT(*) FROM notes o WHERE o.project = n.project AND o.status = 'open') AS open_notes,
             (SELECT t.status FROM tasks t WHERE t.project = n.project AND t.status IS NOT NULL AND t.status <> ''
               ORDER BY t.id DESC LIMIT 1) AS status,
             MAX(COALESCE((SELECT MAX(t.created_at) FROM tasks t WHERE t.project = n.project), ''),
                 COALESCE((SELECT MAX(o.created_at) FROM notes o WHERE o.project = n.project), '')) AS last_activity
      FROM names n
      ORDER BY last_activity DESC`),
  };

  function rowToTask(row) {
    return row && { ...row, files: parseJsonArray(row.files) };
  }
  function rowToNote(row) {
    return row && { ...row, images: parseJsonArray(row.images) };
  }

  return {
    raw: db,
    close: () => db.close(),

    saveTask(t) {
      const params = {
        project: t.project,
        task: t.task || '',
        summary: t.summary || '',
        files: JSON.stringify(t.files || []),
        status: t.status || null,
        session_id: t.session_id || null,
        source: t.source === 'hook' ? 'hook' : 'agent',
      };
      if (params.source === 'hook' && params.session_id) {
        const existing = q.findHookTask.get(params.session_id);
        if (existing) {
          q.updateHookTask.run({ ...params, id: existing.id });
          return { task: rowToTask(q.getTask.get(existing.id)), created: false };
        }
      }
      const info = q.insertTask.run(params);
      return { task: rowToTask(q.getTask.get(info.lastInsertRowid)), created: true };
    },

    listTasks({ project, limit = 100, before } = {}) {
      const where = [];
      const args = [];
      if (project) { where.push('project = ?'); args.push(project); }
      if (before) { where.push('id < ?'); args.push(before); }
      const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit).map(rowToTask);
    },

    deleteTask: (id) => q.deleteTask.run(id).changes > 0,

    listProjects: () => q.projects.all(),

    createNote(n) {
      const info = q.insertNote.run({
        project: n.project,
        text: n.text || '',
        audio_path: n.audio_path || null,
        images: JSON.stringify(n.images || []),
      });
      return rowToNote(q.getNote.get(info.lastInsertRowid));
    },

    getNote: (id) => rowToNote(q.getNote.get(id)),

    updateNote(id, patch) {
      const sets = [];
      const args = {};
      if (patch.status !== undefined) {
        sets.push('status = @status');
        sets.push(`done_at = CASE WHEN @status = 'done' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END`);
        args.status = patch.status;
      }
      if (patch.text !== undefined) { sets.push('text = @text'); args.text = patch.text; }
      if (patch.project !== undefined) { sets.push('project = @project'); args.project = patch.project; }
      if (!sets.length) return rowToNote(q.getNote.get(id));
      const info = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = @id`).run({ ...args, id });
      return info.changes ? rowToNote(q.getNote.get(id)) : null;
    },

    listNotes({ project, status } = {}) {
      const where = [];
      const args = [];
      if (project) { where.push('project = ?'); args.push(project); }
      if (status) { where.push('status = ?'); args.push(status); }
      const sql = `SELECT * FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
      return db.prepare(sql).all(...args).map(rowToNote);
    },

    deleteNote: (id) => q.deleteNote.run(id).changes > 0,
  };
}

module.exports = { openDb };
