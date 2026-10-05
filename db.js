'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// Исходная схема (версия 0). Новые изменения — только через MIGRATIONS, чтобы
// базы, созданные раньше, обновлялись без потери данных.
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  task        TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  files       TEXT NOT NULL DEFAULT '[]',
  status      TEXT,
  session_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'agent',
  created_at  TEXT NOT NULL DEFAULT (${NOW})
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
  created_at  TEXT NOT NULL DEFAULT (${NOW}),
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project, status, id DESC);
`;

const MIGRATIONS = [
  // 1: закрепление/архив/прогресс проектов, этапы, кто закрыл правку
  (db) => {
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols('tasks').includes('stage')) db.exec('ALTER TABLE tasks ADD COLUMN stage TEXT');
    if (!cols('notes').includes('done_by')) db.exec('ALTER TABLE notes ADD COLUMN done_by TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name         TEXT PRIMARY KEY,
        pinned       INTEGER NOT NULL DEFAULT 0,
        pinned_at    TEXT,
        archived     INTEGER NOT NULL DEFAULT 0,
        archived_at  TEXT,
        progress     INTEGER CHECK (progress BETWEEN 0 AND 100)
      );
      CREATE TABLE IF NOT EXISTS stages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT NOT NULL,
        position      INTEGER NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'active', 'done')),
        completed_at  TEXT,
        created_at    TEXT NOT NULL DEFAULT (${NOW})
      );
      CREATE INDEX IF NOT EXISTS idx_stages_project ON stages(project, position);
      CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(project, stage);
    `);
  },
];

const STAGE_STATUSES = new Set(['todo', 'active', 'done']);

function parseJsonArray(value) {
  try {
    const v = JSON.parse(value || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Готовность: процент от агента, иначе по этапам (текущий этап — наполовину)
function effectiveProgress(reported, total, done, active) {
  if (reported !== null && reported !== undefined) return reported;
  if (!total) return null;
  return Math.round(((done + active * 0.5) / total) * 100);
}

function migrate(db) {
  db.exec(BASE_SCHEMA);
  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'dashboard.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  migrate(db);

  const q = {
    insertTask: db.prepare(`INSERT INTO tasks (project, task, summary, files, status, session_id, source, stage)
                            VALUES (@project, @task, @summary, @files, @status, @session_id, @source, @stage)`),
    // Хук SessionEnd может сработать несколько раз для одной сессии (resume → exit):
    // обновляем его запись, а не плодим дубли.
    findHookTask: db.prepare(`SELECT id FROM tasks WHERE session_id = ? AND source = 'hook' ORDER BY id DESC LIMIT 1`),
    updateHookTask: db.prepare(`UPDATE tasks SET project = @project, task = @task, summary = @summary, files = @files,
                                status = COALESCE(@status, status), stage = COALESCE(@stage, stage) WHERE id = @id`),
    sessionStage: db.prepare(`SELECT stage FROM tasks WHERE session_id = ? AND source = 'agent' AND stage IS NOT NULL
                              ORDER BY id DESC LIMIT 1`),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),

    insertNote: db.prepare(`INSERT INTO notes (project, text, audio_path, images)
                            VALUES (@project, @text, @audio_path, @images)`),
    getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

    ensureProject: db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)'),
    getProjectRow: db.prepare('SELECT * FROM projects WHERE name = ?'),
    // новая активность возвращает проект из архива
    unarchive: db.prepare('UPDATE projects SET archived = 0, archived_at = NULL WHERE name = ? AND archived = 1'),
    setProgress: db.prepare('UPDATE projects SET progress = ? WHERE name = ?'),

    stages: db.prepare('SELECT * FROM stages WHERE project = ? ORDER BY position, id'),
    getStage: db.prepare('SELECT * FROM stages WHERE id = ? AND project = ?'),
    insertStage: db.prepare(`INSERT INTO stages (project, position, title, description, status, completed_at)
                             VALUES (@project, @position, @title, @description, @status,
                                     CASE WHEN @status = 'done' THEN ${NOW} END)`),
    updateStage: db.prepare(`UPDATE stages SET position = @position, title = @title, description = @description,
                               completed_at = CASE WHEN @status = 'done' THEN COALESCE(completed_at, ${NOW}) END,
                               status = @status
                             WHERE id = @id`),
    deleteStage: db.prepare('DELETE FROM stages WHERE id = ?'),
    renameStageTasks: db.prepare('UPDATE tasks SET stage = ? WHERE project = ? AND stage = ?'),
    stageTasks: db.prepare(`SELECT id, task, substr(summary, 1, 400) AS summary, source, session_id, created_at
                            FROM tasks WHERE project = ? AND stage = ? ORDER BY id DESC LIMIT 200`),

    projects: db.prepare(`
      WITH names AS (
        SELECT project FROM tasks UNION SELECT project FROM notes
        UNION SELECT name FROM projects UNION SELECT project FROM stages
      )
      SELECT n.project AS name,
             (SELECT COUNT(*) FROM tasks t WHERE t.project = n.project) AS tasks,
             (SELECT COUNT(*) FROM notes o WHERE o.project = n.project AND o.status = 'open') AS open_notes,
             (SELECT t.status FROM tasks t WHERE t.project = n.project AND t.status IS NOT NULL AND t.status <> ''
               ORDER BY t.id DESC LIMIT 1) AS status,
             MAX(COALESCE((SELECT MAX(t.created_at) FROM tasks t WHERE t.project = n.project), ''),
                 COALESCE((SELECT MAX(o.created_at) FROM notes o WHERE o.project = n.project), '')) AS last_activity,
             COALESCE(p.pinned, 0) AS pinned,
             COALESCE(p.archived, 0) AS archived,
             p.progress AS reported_progress,
             (SELECT COUNT(*) FROM stages s WHERE s.project = n.project) AS stages_total,
             (SELECT COUNT(*) FROM stages s WHERE s.project = n.project AND s.status = 'done') AS stages_done,
             (SELECT COUNT(*) FROM stages s WHERE s.project = n.project AND s.status = 'active') AS stages_active,
             (SELECT s.title FROM stages s WHERE s.project = n.project AND s.status = 'active'
               ORDER BY s.position LIMIT 1) AS current_stage
      FROM names n LEFT JOIN projects p ON p.name = n.project
      ORDER BY pinned DESC, p.pinned_at ASC, last_activity DESC`),
  };

  const rowToTask = (row) => row && { ...row, files: parseJsonArray(row.files) };
  const rowToNote = (row) => row && { ...row, images: parseJsonArray(row.images) };
  const rowToProject = (row) => {
    if (!row) return row;
    const { reported_progress, stages_active, ...rest } = row;
    return {
      ...rest,
      pinned: !!row.pinned,
      archived: !!row.archived,
      progress: effectiveProgress(reported_progress, row.stages_total, row.stages_done, stages_active),
      reported_progress,
    };
  };

  function touchProject(name) {
    q.ensureProject.run(name);
    q.unarchive.run(name);
  }

  // Находит этап по названию (без учёта регистра); если нет — добавляет в конец как текущий
  function resolveStage(project, title) {
    const stages = q.stages.all(project);
    const found = stages.find((s) => sameTitle(s.title, title));
    if (found) {
      if (found.status === 'todo') {
        const { id, position, title: t, description } = found;
        q.updateStage.run({ id, position, title: t, description, status: 'active' });
      }
      return found.title;
    }
    const position = stages.length ? Math.max(...stages.map((s) => s.position)) + 1 : 0;
    q.insertStage.run({ project, position, title: title.trim(), description: '', status: 'active' });
    return title.trim();
  }

  const saveTask = db.transaction((t) => {
    const params = {
      project: t.project,
      task: t.task || '',
      summary: t.summary || '',
      files: JSON.stringify(t.files || []),
      status: t.status || null,
      session_id: t.session_id || null,
      source: t.source === 'hook' ? 'hook' : 'agent',
      stage: null,
    };
    touchProject(params.project);
    if (t.stage) params.stage = resolveStage(params.project, t.stage);
    else if (params.source === 'hook' && params.session_id) {
      const inherited = q.sessionStage.get(params.session_id);
      if (inherited) params.stage = inherited.stage;
    }
    if (t.progress !== null && t.progress !== undefined) q.setProgress.run(t.progress, params.project);

    if (params.source === 'hook' && params.session_id) {
      const existing = q.findHookTask.get(params.session_id);
      if (existing) {
        q.updateHookTask.run({ ...params, id: existing.id });
        return { task: rowToTask(q.getTask.get(existing.id)), created: false };
      }
    }
    const info = q.insertTask.run(params);
    return { task: rowToTask(q.getTask.get(info.lastInsertRowid)), created: true };
  });

  // Полная замена плана этапов. Этапы сопоставляются по id, иначе по названию:
  // так сохраняются даты завершения и привязка задач. Описание можно не передавать.
  const replaceStages = db.transaction((project, list) => {
    q.ensureProject.run(project);
    const existing = q.stages.all(project);
    const kept = new Set();
    list.forEach((item, position) => {
      const prev = (item.id && existing.find((s) => s.id === item.id && !kept.has(s.id)))
        || existing.find((s) => !kept.has(s.id) && sameTitle(s.title, item.title));
      if (prev) {
        kept.add(prev.id);
        q.updateStage.run({
          id: prev.id,
          position,
          title: item.title,
          description: item.description !== undefined ? item.description : prev.description,
          status: item.status || prev.status,
        });
        if (prev.title !== item.title) q.renameStageTasks.run(item.title, project, prev.title);
      } else {
        q.insertStage.run({ project, position, title: item.title, description: item.description || '', status: item.status || 'todo' });
      }
    });
    for (const s of existing) if (!kept.has(s.id)) q.deleteStage.run(s.id);
  });

  const updateStage = db.transaction((project, id, patch) => {
    const prev = q.getStage.get(id, project);
    if (!prev) return null;
    const title = patch.title !== undefined ? patch.title : prev.title;
    q.updateStage.run({
      id,
      position: prev.position,
      title,
      description: patch.description !== undefined ? patch.description : prev.description,
      status: patch.status || prev.status,
    });
    if (title !== prev.title) q.renameStageTasks.run(title, project, prev.title);
    return q.getStage.get(id, project);
  });

  function listProjects() {
    return q.projects.all().map(rowToProject);
  }

  return {
    raw: db,
    close: () => db.close(),

    saveTask,

    listTasks({ project, stage, limit = 100, before, excludeArchived = false } = {}) {
      const where = [];
      const args = [];
      if (project) { where.push('project = ?'); args.push(project); }
      if (stage) { where.push('stage = ?'); args.push(stage); }
      if (before) { where.push('id < ?'); args.push(before); }
      if (excludeArchived) where.push('project NOT IN (SELECT name FROM projects WHERE archived = 1)');
      const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit).map(rowToTask);
    },

    deleteTask: (id) => q.deleteTask.run(id).changes > 0,

    listProjects,

    getProject(name, { withTasks = true } = {}) {
      const summary = listProjects().find((p) => p.name === name);
      if (!summary) return null;
      const stages = q.stages.all(name).map((s) => ({
        ...s,
        tasks: withTasks ? q.stageTasks.all(name, s.title) : undefined,
      }));
      return { ...summary, stages };
    },

    updateProject(name, patch) {
      q.ensureProject.run(name);
      const sets = [];
      const args = { name };
      if (patch.pinned !== undefined) {
        sets.push('pinned = @pinned', `pinned_at = CASE WHEN @pinned = 1 THEN COALESCE(pinned_at, ${NOW}) END`);
        args.pinned = patch.pinned ? 1 : 0;
      }
      if (patch.archived !== undefined) {
        sets.push('archived = @archived', `archived_at = CASE WHEN @archived = 1 THEN ${NOW} END`);
        args.archived = patch.archived ? 1 : 0;
      }
      if (patch.progress !== undefined) { sets.push('progress = @progress'); args.progress = patch.progress; }
      if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE name = @name`).run(args);
    },

    replaceStages,
    updateStage,

    createNote(n) {
      touchProject(n.project);
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
        sets.push(`done_at = CASE WHEN @status = 'done' THEN ${NOW} ELSE NULL END`);
        sets.push(`done_by = CASE WHEN @status = 'done' THEN @done_by ELSE NULL END`);
        args.status = patch.status;
        args.done_by = patch.done_by || 'claude';
      }
      if (patch.text !== undefined) { sets.push('text = @text'); args.text = patch.text; }
      if (patch.project !== undefined) { sets.push('project = @project'); args.project = patch.project; }
      if (!sets.length) return rowToNote(q.getNote.get(id));
      const info = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = @id`).run({ ...args, id });
      return info.changes ? rowToNote(q.getNote.get(id)) : null;
    },

    listNotes({ project, status, excludeArchived = false } = {}) {
      const where = [];
      const args = [];
      if (project) { where.push('project = ?'); args.push(project); }
      if (status) { where.push('status = ?'); args.push(status); }
      if (excludeArchived) where.push('project NOT IN (SELECT name FROM projects WHERE archived = 1)');
      const sql = `SELECT * FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
      return db.prepare(sql).all(...args).map(rowToNote);
    },

    deleteNote: (id) => q.deleteNote.run(id).changes > 0,
  };
}

module.exports = { openDb, STAGE_STATUSES };
