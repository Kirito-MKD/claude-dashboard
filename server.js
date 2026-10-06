'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const { openDb, STAGE_STATUSES } = require('./db');
const { version: VERSION } = require('./package.json');

// Версия набора эндпоинтов: интерфейс сверяет её с /api/health и предупреждает,
// если запущен устаревший сервер (например, после git pull без перезапуска).
const API_LEVEL = 3;

function diskVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch {
    return VERSION;
  }
}

const DEFAULT_PORT = 4000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  'audio/webm': '.webm', 'video/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- нормализация входных данных ----------

function str(value, max) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function optStr(value, max) {
  const s = str(value, max).trim();
  return s ? s : null;
}

function requireProject(value) {
  const p = str(value, 200).trim();
  if (!p) throw new HttpError(400, 'Поле "project" обязательно');
  return p;
}

// files может прийти массивом, JSON-строкой или строкой через запятую/перевод строки
function normalizeFiles(value) {
  let list = value;
  if (typeof list === 'string') {
    const s = list.trim();
    if (!s) return [];
    try { list = JSON.parse(s); } catch { list = s.split(/[\n,]/); }
  }
  if (!Array.isArray(list)) list = list ? [list] : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const f = str(item, 1000).trim();
    if (f && !seen.has(f)) { seen.add(f); out.push(f); }
    if (out.length >= 2000) break;
  }
  return out;
}

// Процент готовности: undefined — не передан, null — сбросить (считать по этапам)
function parseProgress(value, { allowNull = false } = {}) {
  if (value === undefined || value === '') return undefined;
  if (value === null) {
    if (allowNull) return null;
    return undefined;
  }
  const n = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(n)) throw new HttpError(400, 'progress должен быть числом от 0 до 100');
  return Math.min(100, Math.max(0, Math.round(n)));
}

const STATUS_ALIASES = {
  todo: 'todo', pending: 'todo', planned: 'todo', open: 'todo',
  active: 'active', in_progress: 'active', 'in-progress': 'active', doing: 'active', current: 'active',
  done: 'done', completed: 'done', complete: 'done', finished: 'done',
};

function parseStageStatus(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const status = STATUS_ALIASES[String(value).trim().toLowerCase()];
  if (!status || !STAGE_STATUSES.has(status)) throw new HttpError(400, 'Статус этапа: todo, active или done');
  return status;
}

// Иконка этапа — короткое имя из набора интерфейса; пустая строка сбрасывает на автоподбор
function parseIcon(value) {
  if (value === undefined) return undefined;
  const icon = str(value, 30).trim().toLowerCase();
  if (!icon) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(icon)) throw new HttpError(400, 'icon — короткое имя иконки латиницей, например "rocket"');
  return icon;
}

// План этапов: массив или { stages: [...] }; элемент — строка-название или объект
function parseStages(body) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.stages) ? body.stages : null;
  if (!list) throw new HttpError(400, 'Ожидается { "stages": [ { "title", "description", "status" }, ... ] }');
  if (list.length > 40) throw new HttpError(400, 'Слишком много этапов (максимум 40)');
  const seen = new Set();
  return list.map((raw) => {
    const item = typeof raw === 'string' ? { title: raw } : raw || {};
    const title = str(item.title !== undefined ? item.title : item.name, 200).trim();
    if (!title) throw new HttpError(400, 'У каждого этапа должно быть название (title)');
    const key = title.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, `Этап «${title}» указан дважды`);
    seen.add(key);
    const id = Number(item.id);
    return {
      id: Number.isInteger(id) && id > 0 ? id : undefined,
      title,
      description: item.description !== undefined ? str(item.description, 4000).trim() : undefined,
      status: parseStageStatus(item.status),
      icon: parseIcon(item.icon),
    };
  });
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный id');
  return id;
}

// ---------- приложение ----------

function createApp(options = {}) {
  const port = options.port || Number(process.env.PORT) || DEFAULT_PORT;
  const dataDir = path.resolve(options.dataDir || process.env.AGENT_DASHBOARD_DATA || path.join(__dirname, 'data'));
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const db = openDb(dataDir);
  const app = express();
  app.disable('x-powered-by');

  const allowedHosts = new Set([
    ...LOCAL_HOSTS,
    ...String(process.env.AGENT_DASHBOARD_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  ]);
  const hostOf = (hostHeader) => {
    const h = String(hostHeader || '').toLowerCase();
    if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
    return h.split(':')[0];
  };

  // Сервер слушает только localhost, но браузер всё равно может достучаться до него
  // с любого сайта (CSRF, DNS rebinding). Правки попадают в контекст Claude через
  // хук SessionStart, поэтому чужие сайты не должны уметь их создавать.
  app.use((req, res, next) => {
    if (!allowedHosts.has(hostOf(req.headers.host))) {
      return res.status(403).json({ error: 'Недопустимый Host' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined) {
      let originHost = null;
      try { originHost = new URL(req.headers.origin).hostname; } catch { /* "null" и мусор */ }
      if (!originHost || !allowedHosts.has(originHost.toLowerCase())) {
        return res.status(403).json({ error: 'Запросы с чужих сайтов запрещены' });
      }
    }
    next();
  });

  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', fallthrough: false }));

  // ---------- живые обновления (Server-Sent Events) ----------
  const clients = new Set();
  function broadcast(kind, project) {
    const payload = `event: change\ndata: ${JSON.stringify({ kind, project })}\n\n`;
    for (const res of clients) res.write(payload);
  }
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // ---------- helpers ----------
  const fileUrl = (name) => `/uploads/${name}`;
  const urlToFile = (url) => (url ? path.join(uploadDir, path.basename(url)) : null);
  function serializeNote(note) {
    if (!note) return note;
    return {
      ...note,
      // абсолютные пути нужны хуку SessionStart: Claude может открыть скриншот через Read
      audio_file: urlToFile(note.audio_path),
      image_files: note.images.map(urlToFile),
    };
  }
  function removeFiles(urls) {
    for (const url of urls) {
      if (!url) continue;
      fs.rm(urlToFile(url), { force: true }, () => {});
    }
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => {
        const mime = String(file.mimetype || '').split(';')[0].toLowerCase();
        let ext = MIME_EXT[mime] || path.extname(file.originalname || '').toLowerCase();
        if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = file.fieldname === 'audio' ? '.webm' : '.png';
        cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 31, fields: 20 },
    fileFilter: (req, file, cb) => {
      const mime = String(file.mimetype || '').toLowerCase();
      const ok = file.fieldname === 'audio'
        ? mime.startsWith('audio/') || mime.startsWith('video/webm')
        : mime.startsWith('image/');
      cb(ok ? null : new HttpError(400, `Неподдерживаемый тип файла "${file.mimetype}" в поле "${file.fieldname}"`), ok);
    },
  });
  const noteUpload = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'images', maxCount: 30 }]);

  // ---------- API ----------
  app.get('/api/health', (req, res) => {
    const onDisk = diskVersion();
    res.json({
      ok: true,
      app: 'agent-dashboard',
      version: VERSION,
      api: API_LEVEL,
      pid: process.pid,
      // код на диске обновили (git pull), а процесс работает со старым
      stale: onDisk !== VERSION,
      disk_version: onDisk,
      can_restart: typeof options.onRestart === 'function',
    });
  });

  app.post('/api/restart', (req, res) => {
    if (typeof options.onRestart !== 'function') throw new HttpError(501, 'Перезапуск недоступен');
    res.json({ ok: true, restarting: true, pid: process.pid });
    res.on('finish', () => setTimeout(options.onRestart, 50));
  });

  app.post('/api/tasks', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { task, created } = db.saveTask({
      project: requireProject(b.project),
      task: str(b.task, 20000).trim(),
      summary: str(b.summary, 50000).trim(),
      files: normalizeFiles(b.files),
      status: optStr(b.status, 2000),
      session_id: optStr(b.session_id, 200),
      source: b.source === 'hook' ? 'hook' : 'agent',
      stage: optStr(b.stage, 200),
      progress: parseProgress(b.progress),
    });
    broadcast('task', task.project);
    res.status(created ? 201 : 200).json(task);
  });

  app.get('/api/tasks', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const before = req.query.before ? parseId(req.query.before) : undefined;
    res.json(db.listTasks({
      project: optStr(req.query.project, 200),
      stage: optStr(req.query.stage, 200),
      excludeArchived: req.query.hide_archived === '1',
      limit,
      before,
    }));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    if (!db.deleteTask(parseId(req.params.id))) throw new HttpError(404, 'Задача не найдена');
    broadcast('task', null);
    res.status(204).end();
  });

  app.get('/api/projects', (req, res) => res.json(db.listProjects()));

  app.get('/api/projects/:name', (req, res) => {
    const project = db.getProject(req.params.name, { withTasks: req.query.tasks !== '0' });
    if (!project) throw new HttpError(404, 'Проект не найден');
    res.json(project);
  });

  app.patch('/api/projects/:name', (req, res) => {
    const name = requireProject(req.params.name);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.pinned !== undefined) patch.pinned = !!b.pinned;
    if (b.archived !== undefined) patch.archived = !!b.archived;
    if (b.plan_skipped !== undefined) patch.plan_skipped = !!b.plan_skipped;
    const progress = parseProgress(b.progress, { allowNull: true });
    if (progress !== undefined) patch.progress = progress;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Нечего менять: передайте pinned, archived, plan_skipped или progress');
    if (!db.getProject(name, { withTasks: false })) throw new HttpError(404, 'Проект не найден');
    db.updateProject(name, patch);
    broadcast('project', name);
    res.json(db.getProject(name, { withTasks: false }));
  });

  function putStages(name, body, res) {
    const b = body && typeof body === 'object' ? body : {};
    // {"project": "...", "skip": true} — пользователь попросил обойтись без плана
    const skipOnly = (b.skip === true || b.plan_skipped === true) && b.stages === undefined;
    const patch = {};
    if (!skipOnly) {
      const stages = parseStages(b);
      db.replaceStages(name, stages);
      if (stages.length) patch.plan_skipped = false;
    }
    if (b.skip !== undefined) patch.plan_skipped = !!b.skip;
    if (b.plan_skipped !== undefined) patch.plan_skipped = !!b.plan_skipped;
    const progress = parseProgress(b.progress, { allowNull: true });
    if (progress !== undefined) patch.progress = progress;
    db.updateProject(name, patch);
    broadcast('project', name);
    res.json(db.getProject(name));
  }
  app.put('/api/projects/:name/stages', (req, res) => putStages(requireProject(req.params.name), req.body, res));
  // То же, но проект в теле — агенту не нужно кодировать кириллицу в URL
  app.put('/api/stages', (req, res) => putStages(requireProject(req.body && req.body.project), req.body, res));

  app.patch('/api/projects/:name/stages/:id', (req, res) => {
    const name = requireProject(req.params.name);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.title !== undefined) {
      patch.title = str(b.title, 200).trim();
      if (!patch.title) throw new HttpError(400, 'Название этапа не может быть пустым');
      const clash = (db.getProject(name, { withTasks: false }) || { stages: [] }).stages
        .find((s) => s.id !== Number(req.params.id) && s.title.toLowerCase() === patch.title.toLowerCase());
      if (clash) throw new HttpError(400, `Этап «${patch.title}» уже есть`);
    }
    if (b.description !== undefined) patch.description = str(b.description, 4000).trim();
    const icon = parseIcon(b.icon);
    if (icon !== undefined) patch.icon = icon;
    const status = parseStageStatus(b.status);
    if (status) patch.status = status;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Нечего менять: передайте status, title, description или icon');
    const stage = db.updateStage(name, parseId(req.params.id), patch);
    if (!stage) throw new HttpError(404, 'Этап не найден');
    broadcast('project', name);
    res.json(stage);
  });

  app.post('/api/notes', (req, res, next) => {
    noteUpload(req, res, (err) => {
      const uploaded = Object.values(req.files || {}).flat();
      const cleanup = () => uploaded.forEach((f) => fs.rmSync(f.path, { force: true }));
      if (err) { cleanup(); return next(err); }
      try {
        const b = req.body || {};
        const project = requireProject(b.project);
        const text = str(b.text, 50000).trim();
        const audio = (req.files && req.files.audio && req.files.audio[0]) || null;
        const images = (req.files && req.files.images) || [];
        if (!text && !audio && !images.length) throw new HttpError(400, 'Правка пустая: нужен текст, аудио или картинка');
        const note = db.createNote({
          project,
          text,
          audio_path: audio ? fileUrl(audio.filename) : null,
          images: images.map((f) => fileUrl(f.filename)),
        });
        broadcast('note', project);
        res.status(201).json(serializeNote(note));
      } catch (e) {
        cleanup();
        next(e);
      }
    });
  });

  app.get('/api/notes', (req, res) => {
    const status = optStr(req.query.status, 10);
    if (status && status !== 'open' && status !== 'done') throw new HttpError(400, 'status должен быть open или done');
    res.json(db.listNotes({
      project: optStr(req.query.project, 200),
      status,
      excludeArchived: req.query.hide_archived === '1',
    }).map(serializeNote));
  });

  app.patch('/api/notes/:id', (req, res) => {
    const id = parseId(req.params.id);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    let status = b.status;
    if (status === undefined && typeof b.done === 'boolean') status = b.done ? 'done' : 'open';
    if (status !== undefined) {
      if (status !== 'open' && status !== 'done') throw new HttpError(400, 'status должен быть open или done');
      patch.status = status;
      // кто закрыл правку: интерфейс дашборда передаёт "user", всё остальное (curl агента) — Claude
      if (status === 'done') {
        const by = String(b.done_by || 'claude').trim().toLowerCase();
        if (by !== 'user' && by !== 'claude') throw new HttpError(400, 'done_by должен быть user или claude');
        patch.done_by = by;
      }
    }
    if (b.text !== undefined) patch.text = str(b.text, 50000).trim();
    if (b.project !== undefined) patch.project = requireProject(b.project);
    if (!Object.keys(patch).length) throw new HttpError(400, 'Нечего менять: передайте status, text или project');
    const note = db.updateNote(id, patch);
    if (!note) throw new HttpError(404, 'Правка не найдена');
    broadcast('note', note.project);
    res.json(serializeNote(note));
  });

  app.delete('/api/notes/:id', (req, res) => {
    const id = parseId(req.params.id);
    const note = db.getNote(id);
    if (!note || !db.deleteNote(id)) throw new HttpError(404, 'Правка не найдена');
    removeFiles([note.audio_path, ...note.images]);
    broadcast('note', note.project);
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Нет такого API' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Внутренняя ошибка';
    if (err instanceof multer.MulterError) {
      status = 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 50 МБ' : `Ошибка загрузки: ${err.message} (${err.field || ''})`;
    } else if (err.type === 'entity.parse.failed') {
      message = 'Тело запроса — некорректный JSON';
    }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  function close() {
    for (const res of clients) res.end();
    clients.clear();
    db.close();
  }

  return { app, db, close, port, dataDir, uploadDir };
}

// Под launchd/systemd (их настраивает npm run autostart) перезапуском занимается менеджер:
// достаточно завершиться с ошибкой. Иначе (Windows, ручной запуск) запускаем замену сами.
function isSupervised() {
  return process.env.AGENT_DASHBOARD_SUPERVISED === '1'
    || String(process.env.XPC_SERVICE_NAME || '').includes('agent-dashboard');
}

function main() {
  const host = process.env.HOST || '127.0.0.1';
  let server;
  let ctx;
  const restart = () => {
    console.log('Перезапуск по запросу из интерфейса…');
    if (!isSupervised()) {
      const out = fs.openSync(path.join(ctx.dataDir, 'server.log'), 'a');
      spawn(process.execPath, [__filename], {
        cwd: __dirname,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, AGENT_DASHBOARD_RESTARTING: '1' },
      }).unref();
    }
    server.close();
    server.closeAllConnections();
    ctx.close();
    process.exit(isSupervised() ? 1 : 0);
  };
  ctx = createApp({ onRestart: restart });
  const { app, port, dataDir } = ctx;
  // новый процесс после перезапуска ждёт, пока старый освободит порт
  const deadline = Date.now() + (process.env.AGENT_DASHBOARD_RESTARTING === '1' ? 15000 : 0);
  const listen = () => {
    server = app.listen(port, host, () => {
      console.log(`Agent dashboard ${VERSION}: http://localhost:${port}  (данные: ${dataDir})`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (Date.now() < deadline) return setTimeout(listen, 250);
        console.error(`Порт ${port} занят — дашборд уже запущен? Проверьте http://localhost:${port}`);
        process.exit(1);
      }
      throw err;
    });
  };
  listen();
}

if (require.main === module) main();

module.exports = { createApp, normalizeFiles, API_LEVEL };
