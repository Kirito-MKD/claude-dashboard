'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer, PNG_1PX } = require('./helpers');
const { normalizeFiles } = require('../server');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.stop(); });

const json = (method, body, headers = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const call = async (path, opts) => {
  const res = await fetch(srv.base + path, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('POST /api/tasks создаёт задачу, GET отдаёт свежие сверху с фильтром по проекту', async () => {
  const a = await call('/api/tasks', json('POST', { project: 'alpha', task: 'первая', summary: 'готово', files: ['a.js'], status: 'MVP' }));
  assert.equal(a.status, 201);
  assert.equal(a.body.project, 'alpha');
  assert.deepEqual(a.body.files, ['a.js']);
  assert.equal(a.body.source, 'agent');
  assert.match(a.body.created_at, /^\d{4}-\d\d-\d\dT/);

  await call('/api/tasks', json('POST', { project: 'beta', task: 'чужая' }));
  const b = await call('/api/tasks', json('POST', { project: 'alpha', task: 'вторая', files: 'x.js, y.js' }));
  assert.deepEqual(b.body.files, ['x.js', 'y.js']);

  const list = await call('/api/tasks?project=alpha');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((t) => t.task), ['вторая', 'первая']);

  const all = await call('/api/tasks');
  assert.equal(all.body.length, 3);
});

test('POST /api/tasks без project — 400, кривой JSON — 400', async () => {
  const r = await call('/api/tasks', json('POST', { task: 'x' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /project/);
  const bad = await call('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('хук с тем же session_id обновляет свою запись, а отчёты агента добавляются', async () => {
  const first = await call('/api/tasks', json('POST', { project: 'gamma', task: 'q', files: ['1.js'], session_id: 's-1', source: 'hook' }));
  assert.equal(first.status, 201);
  const again = await call('/api/tasks', json('POST', { project: 'gamma', task: 'q', files: ['1.js', '2.js'], session_id: 's-1', source: 'hook' }));
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.deepEqual(again.body.files, ['1.js', '2.js']);
  await call('/api/tasks', json('POST', { project: 'gamma', summary: 'отчёт', session_id: 's-1' }));
  await call('/api/tasks', json('POST', { project: 'gamma', summary: 'отчёт 2', session_id: 's-1' }));
  const list = await call('/api/tasks?project=gamma');
  assert.equal(list.body.length, 3);
});

test('GET /api/projects: счётчики, последний статус, открытые правки', async () => {
  await call('/api/tasks', json('POST', { project: 'delta', task: 't1', status: 'старый статус' }));
  await call('/api/tasks', json('POST', { project: 'delta', task: 't2', status: 'новый статус' }));
  await call('/api/tasks', json('POST', { project: 'delta', task: 't3' }));
  await call('/api/notes', json('POST', { project: 'delta', text: 'поправить кнопку' }));
  const r = await call('/api/projects');
  const delta = r.body.find((p) => p.name === 'delta');
  assert.equal(delta.tasks, 3);
  assert.equal(delta.status, 'новый статус');
  assert.equal(delta.open_notes, 1);
  assert.equal(r.body[0].name, 'delta', 'самый свежий проект первым');
  // проект, у которого есть только правки, тоже в списке
  await call('/api/notes', json('POST', { project: 'only-notes', text: 'x' }));
  const r2 = await call('/api/projects');
  assert.equal(r2.body.find((p) => p.name === 'only-notes').tasks, 0);
});

test('POST /api/notes multipart: текст + аудио + картинки, файлы доступны по URL', async () => {
  const fd = new FormData();
  fd.append('project', 'notes-proj');
  fd.append('text', 'Кнопка съехала');
  fd.append('audio', new Blob([Buffer.from('fake-webm')], { type: 'audio/webm;codecs=opus' }), 'voice.webm');
  fd.append('images', new Blob([PNG_1PX], { type: 'image/png' }), 'shot1.png');
  fd.append('images', new Blob([PNG_1PX], { type: 'image/png' }), 'shot2.png');
  const r = await call('/api/notes', { method: 'POST', body: fd });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.text, 'Кнопка съехала');
  assert.equal(r.body.status, 'open');
  assert.match(r.body.audio_path, /^\/uploads\/\d+-[0-9a-f]+\.webm$/);
  assert.equal(r.body.images.length, 2);
  assert.ok(r.body.image_files.every((f) => fs.existsSync(f)), 'абсолютные пути картинок существуют');

  const img = await fetch(srv.base + r.body.images[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('POST /api/notes: пустая правка и неверный тип файла — 400, файлы не остаются', async () => {
  const empty = new FormData();
  empty.append('project', 'notes-proj');
  const r = await call('/api/notes', { method: 'POST', body: empty });
  assert.equal(r.status, 400);

  const before = fs.readdirSync(srv.uploadDir).length;
  const bad = new FormData();
  bad.append('project', 'notes-proj');
  bad.append('images', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
  const r2 = await call('/api/notes', { method: 'POST', body: bad });
  assert.equal(r2.status, 400);
  assert.equal(fs.readdirSync(srv.uploadDir).length, before);

  const noProject = new FormData();
  noProject.append('images', new Blob([PNG_1PX], { type: 'image/png' }), 'a.png');
  const r3 = await call('/api/notes', { method: 'POST', body: noProject });
  assert.equal(r3.status, 400);
  assert.equal(fs.readdirSync(srv.uploadDir).length, before, 'загруженная картинка удалена при ошибке');
});

test('GET /api/notes?status=open и PATCH /api/notes/:id', async () => {
  const created = await call('/api/notes', json('POST', { project: 'patch-proj', text: 'сделать X' }));
  await call('/api/notes', json('POST', { project: 'patch-proj', text: 'сделать Y' }));
  let open = await call('/api/notes?project=patch-proj&status=open');
  assert.equal(open.body.length, 2);

  const done = await call(`/api/notes/${created.body.id}`, json('PATCH', { status: 'done' }));
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  assert.ok(done.body.done_at);

  open = await call('/api/notes?project=patch-proj&status=open');
  assert.deepEqual(open.body.map((n) => n.text), ['сделать Y']);
  const doneList = await call('/api/notes?project=patch-proj&status=done');
  assert.equal(doneList.body.length, 1);

  const reopened = await call(`/api/notes/${created.body.id}`, json('PATCH', { done: false, text: 'сделать X иначе' }));
  assert.equal(reopened.body.status, 'open');
  assert.equal(reopened.body.done_at, null);
  assert.equal(reopened.body.text, 'сделать X иначе');

  assert.equal((await call('/api/notes/999999', json('PATCH', { status: 'done' }))).status, 404);
  assert.equal((await call(`/api/notes/${created.body.id}`, json('PATCH', { status: 'maybe' }))).status, 400);
  assert.equal((await call(`/api/notes/${created.body.id}`, json('PATCH', {}))).status, 400);
  assert.equal((await call('/api/notes?status=weird')).status, 400);
});

test('DELETE /api/notes/:id удаляет правку и её файлы', async () => {
  const fd = new FormData();
  fd.append('project', 'del-proj');
  fd.append('images', new Blob([PNG_1PX], { type: 'image/png' }), 'a.png');
  const r = await call('/api/notes', { method: 'POST', body: fd });
  const file = r.body.image_files[0];
  assert.ok(fs.existsSync(file));
  const del = await fetch(`${srv.base}/api/notes/${r.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(file));
  assert.equal((await fetch(`${srv.base}/api/notes/${r.body.id}`, { method: 'DELETE' })).status, 404);
});

test('запросы с чужих сайтов и чужой Host отклоняются', async () => {
  const evil = await call('/api/notes', json('POST', { project: 'x', text: 'rm -rf' }, { Origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  const nullOrigin = await call('/api/tasks', json('POST', { project: 'x' }, { Origin: 'null' }));
  assert.equal(nullOrigin.status, 403);
  const own = await call('/api/notes', json('POST', { project: 'x', text: 'ok' }, { Origin: `http://localhost:${srv.port}` }));
  assert.equal(own.status, 201);

  // DNS rebinding: чужое имя хоста
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: '/api/projects', headers: { Host: 'attacker.example:4000' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('SSE /api/events присылает событие при новой задаче', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/events`, { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  await call('/api/tasks', json('POST', { project: 'sse', task: 'x' }));
  let text = '';
  const deadline = Date.now() + 2000;
  while (!text.includes('event: change') && Date.now() < deadline) {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
  }
  ctrl.abort();
  assert.match(text, /event: change\ndata: \{"kind":"task","project":"sse"\}/);
});

test('normalizeFiles принимает массив, JSON-строку и список через запятую', () => {
  assert.deepEqual(normalizeFiles(['a', 'a', ' b ']), ['a', 'b']);
  assert.deepEqual(normalizeFiles('["x","y"]'), ['x', 'y']);
  assert.deepEqual(normalizeFiles('x\ny, z'), ['x', 'y', 'z']);
  assert.deepEqual(normalizeFiles(undefined), []);
  assert.deepEqual(normalizeFiles(''), []);
});

test('главная страница отдаётся', async () => {
  const res = await fetch(srv.base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Agent Dashboard/);
});

// ---------- проекты: закрепление, архив, этапы, прогресс ----------

const patchProject = (name, body) => call(`/api/projects/${encodeURIComponent(name)}`, json('PATCH', body));
const getProject = (name) => call(`/api/projects/${encodeURIComponent(name)}`);

test('закрепление и архив проектов; новая активность возвращает проект из архива', async () => {
  await call('/api/tasks', json('POST', { project: 'arch-a', task: 'x' }));
  await call('/api/tasks', json('POST', { project: 'arch-b', task: 'y' }));
  await call('/api/notes', json('POST', { project: 'arch-b', text: 'правка' }));

  const pinned = await patchProject('arch-a', { pinned: true });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.pinned, true);
  let list = (await call('/api/projects')).body;
  assert.equal(list[0].name, 'arch-a', 'закреплённый проект первым');

  const archived = await patchProject('arch-b', { archived: true });
  assert.equal(archived.body.archived, true);
  list = (await call('/api/projects')).body;
  assert.equal(list.find((p) => p.name === 'arch-b').archived, true);

  // в общей ленте архивные проекты можно скрыть
  const all = (await call('/api/tasks?hide_archived=1')).body;
  assert.ok(!all.some((t) => t.project === 'arch-b'));
  assert.ok(all.some((t) => t.project === 'arch-a'));
  const notes = (await call('/api/notes?hide_archived=1&status=open')).body;
  assert.ok(!notes.some((n) => n.project === 'arch-b'));
  // а по проекту — всё видно
  assert.equal((await call('/api/tasks?project=arch-b')).body.length, 1);

  await call('/api/tasks', json('POST', { project: 'arch-b', task: 'снова в работе' }));
  assert.equal((await getProject('arch-b')).body.archived, false, 'новая задача разархивирует');

  assert.equal((await patchProject('arch-a', {})).status, 400);
  assert.equal((await getProject('nope-nope')).status, 404);
  assert.equal((await patchProject('nope-nope', { pinned: true })).status, 404, 'опечатка не создаёт пустой проект');
  assert.ok(!(await call('/api/projects')).body.some((p) => p.name === 'nope-nope'));
});

test('этапы: план через PUT, задача с этапом и прогрессом, клик по этапу даёт его задачи', async () => {
  const name = 'Магазин игрушек';
  const put = await call(`/api/projects/${encodeURIComponent(name)}/stages`, json('PUT', {
    stages: [
      { title: 'Прототип', description: 'Каркас и макеты', status: 'done' },
      { title: 'Каталог', description: 'Список товаров, фильтры', status: 'in_progress' },
      'Оплата',
    ],
  }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.stages.map((s) => [s.title, s.status]), [['Прототип', 'done'], ['Каталог', 'active'], ['Оплата', 'todo']]);
  assert.ok(put.body.stages[0].completed_at, 'дата завершения этапа');
  assert.equal(put.body.progress, 50, '(1 готов + 0.5 текущий) / 3');

  // задача с этапом (регистр не важен) и процентом
  const t = await call('/api/tasks', json('POST', { project: name, task: 'Фильтры', summary: 'Добавил фильтр по цене', stage: 'каталог', progress: 45, session_id: 'st-1' }));
  assert.equal(t.body.stage, 'Каталог');
  // хук той же сессии наследует этап отчёта агента
  const hook = await call('/api/tasks', json('POST', { project: name, task: 'Фильтры', files: ['a.js'], session_id: 'st-1', source: 'hook' }));
  assert.equal(hook.body.stage, 'Каталог');
  // неизвестный этап создаётся и становится текущим; todo-этап при задаче становится active
  await call('/api/tasks', json('POST', { project: name, task: 'Доставка', stage: 'Доставка' }));
  await call('/api/tasks', json('POST', { project: name, task: 'Платёжка', stage: 'Оплата' }));

  const p = (await getProject(name)).body;
  assert.equal(p.progress, 45, 'процент агента важнее расчётного');
  assert.deepEqual(p.stages.map((s) => [s.title, s.status]), [['Прототип', 'done'], ['Каталог', 'active'], ['Оплата', 'active'], ['Доставка', 'active']]);
  const catalog = p.stages.find((s) => s.title === 'Каталог');
  assert.deepEqual(catalog.tasks.map((x) => x.source).sort(), ['agent', 'hook']);
  assert.equal(catalog.description, 'Список товаров, фильтры');
  assert.equal((await call(`/api/tasks?project=${encodeURIComponent(name)}&stage=${encodeURIComponent('Каталог')}`)).body.length, 2);

  // повторный PUT без описаний: описания и даты сохраняются; удалённый этап исчезает
  const put2 = await call('/api/stages', json('PUT', { project: name, progress: null, stages: [
    { title: 'Прототип', status: 'done' }, { title: 'Каталог', status: 'done' }, { title: 'Оплата', status: 'active' },
  ] }));
  assert.equal(put2.status, 200);
  assert.deepEqual(put2.body.stages.map((s) => s.title), ['Прототип', 'Каталог', 'Оплата']);
  assert.equal(put2.body.stages[1].description, 'Список товаров, фильтры');
  assert.equal(put2.body.stages[0].completed_at, put.body.stages[0].completed_at);

  // сброс процента агента — снова считается по этапам
  const cleared = await patchProject(name, { progress: null });
  assert.equal(cleared.body.progress, 83, '(2 + 0.5) / 3');

  // переименование этапа из интерфейса тянет за собой задачи
  const stageId = put2.body.stages[1].id;
  const renamed = await call(`/api/projects/${encodeURIComponent(name)}/stages/${stageId}`, json('PATCH', { title: 'Каталог товаров' }));
  assert.equal(renamed.body.title, 'Каталог товаров');
  assert.equal((await call(`/api/tasks?project=${encodeURIComponent(name)}&stage=${encodeURIComponent('Каталог товаров')}`)).body.length, 2);

  // ошибки валидации
  assert.equal((await call('/api/stages', json('PUT', { project: name, stages: ['A', 'a'] }))).status, 400);
  assert.equal((await call('/api/stages', json('PUT', { project: name, stages: [{ title: 'X', status: 'maybe' }] }))).status, 400);
  assert.equal((await call('/api/stages', json('PUT', { stages: [] }))).status, 400);
  assert.equal((await call(`/api/projects/${encodeURIComponent(name)}/stages/999999`, json('PATCH', { status: 'done' }))).status, 404);
  assert.equal((await call('/api/tasks', json('POST', { project: name, progress: 'много' }))).status, 400);
});

test('done_by: из интерфейса — user, по умолчанию (curl агента) — claude, при возврате — сбрасывается', async () => {
  const a = await call('/api/notes', json('POST', { project: 'doneby', text: 'a' }));
  const b = await call('/api/notes', json('POST', { project: 'doneby', text: 'b' }));
  const byClaude = await call(`/api/notes/${a.body.id}`, json('PATCH', { status: 'done' }));
  assert.equal(byClaude.body.done_by, 'claude');
  const byUser = await call(`/api/notes/${b.body.id}`, json('PATCH', { status: 'done', done_by: 'user' }));
  assert.equal(byUser.body.done_by, 'user');
  const reopened = await call(`/api/notes/${b.body.id}`, json('PATCH', { status: 'open' }));
  assert.equal(reopened.body.done_by, null);
  assert.equal((await call(`/api/notes/${a.body.id}`, json('PATCH', { status: 'done', done_by: 'robot' }))).status, 400);
});

test('health сообщает pid и версию (нужно для перезапуска)', async () => {
  const r = await call('/api/health');
  assert.equal(r.body.app, 'agent-dashboard');
  assert.equal(r.body.pid, process.pid);
});
