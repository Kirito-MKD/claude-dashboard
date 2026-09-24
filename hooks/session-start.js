#!/usr/bin/env node
'use strict';
/**
 * Хук SessionStart для Claude Code.
 *
 * Запрашивает у дашборда открытые правки текущего проекта и печатает их в stdout —
 * Claude Code добавляет этот текст в контекст сессии. Скриншоты даются абсолютными
 * путями, чтобы агент мог открыть их инструментом Read.
 * Если дашборд не запущен — ничего не выводит.
 */
const { BASE_URL, debug, readStdin, parseJson, projectDir, projectName, request } = require('./lib/common');

const MAX_NOTES = 30;
const MAX_NOTE_TEXT = 1500;

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatNotes(project, sessionId, notes) {
  const lines = [];
  lines.push(`[Agent Dashboard ${BASE_URL}] Проект в дашборде: «${project}»${sessionId ? `, session_id этой сессии: ${sessionId}` : ''}.`);
  if (!notes.length) {
    lines.push('Открытых правок от пользователя для этого проекта нет.');
    return lines.join('\n');
  }
  const shown = notes.slice(0, MAX_NOTES);
  lines.push(`Открытые правки от пользователя для этого проекта (${notes.length}), от старых к новым:`);
  shown.forEach((n, i) => {
    let text = (n.text || '').trim();
    if (text.length > MAX_NOTE_TEXT) text = text.slice(0, MAX_NOTE_TEXT) + '…';
    if (!text) text = n.audio_path ? '(только голосовая заметка, без расшифровки)' : '(без текста, см. скриншоты)';
    lines.push('');
    lines.push(`${i + 1}. Правка #${n.id} (${formatDate(n.created_at)}):`);
    lines.push(text.split('\n').map((l) => '   ' + l).join('\n'));
    if (n.image_files && n.image_files.length) {
      lines.push(`   Скриншоты (${n.image_files.length}): ${n.image_files.join(', ')}`);
    }
    if (n.audio_file) lines.push(`   Голосовая заметка: ${n.audio_file}`);
  });
  if (notes.length > shown.length) lines.push('', `…и ещё ${notes.length - shown.length}: ${BASE_URL}/api/notes?project=${encodeURIComponent(project)}&status=open`);
  lines.push('');
  lines.push(`Отметка о выполнении правки: curl -s -m 3 -X PATCH ${BASE_URL}/api/notes/<id> -H 'Content-Type: application/json' -d '{"status":"done"}'`);
  return lines.join('\n');
}

async function main() {
  const input = parseJson(await readStdin()) || {};
  const project = projectName(projectDir(input));
  const notes = await request('GET', `/api/notes?project=${encodeURIComponent(project)}&status=open`, null, 1500);
  // API отдаёт свежие сверху, агенту удобнее очередь от старых к новым
  notes.reverse();
  return formatNotes(project, input.session_id, notes) + '\n';
}

if (require.main === module) {
  main()
    .then((text) => process.stdout.write(text, () => process.exit(0)))
    .catch((err) => {
      debug(err && err.message ? err.message : err);
      process.exit(0);
    });
}

module.exports = { formatNotes };
