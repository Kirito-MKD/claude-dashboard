'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { openDb } = require('./db');

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
  app.get('/api/health', (req, res) => res.json({ ok: true }));

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
    });
    broadcast('task', task.project);
    res.status(created ? 201 : 200).json(task);
  });

  app.get('/api/tasks', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const before = req.query.before ? parseId(req.query.before) : undefined;
    res.json(db.listTasks({ project: optStr(req.query.project, 200), limit, before }));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    if (!db.deleteTask(parseId(req.params.id))) throw new HttpError(404, 'Задача не найдена');
    broadcast('task', null);
    res.status(204).end();
  });

  app.get('/api/projects', (req, res) => res.json(db.listProjects()));

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
    res.json(db.listNotes({ project: optStr(req.query.project, 200), status }).map(serializeNote));
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

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const { app, port, dataDir } = createApp();
  const server = app.listen(port, host, () => {
    console.log(`Agent dashboard: http://localhost:${port}  (данные: ${dataDir})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Порт ${port} занят — дашборд уже запущен? Проверьте http://localhost:${port}`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { createApp, normalizeFiles };
