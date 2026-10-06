#!/usr/bin/env node
'use strict';
/**
 * Хук SessionStart для Claude Code.
 *
 * Запрашивает у дашборда этапы и открытые правки текущего проекта и печатает их в stdout —
 * Claude Code добавляет этот текст в контекст сессии. Скриншоты даются абсолютными
 * путями, чтобы агент мог открыть их инструментом Read.
 * Если дашборд не запущен — ничего не выводит.
 */
const { BASE_URL, debug, readStdin, parseJson, projectDir, projectName, request } = require('./lib/common');

const MAX_NOTES = 30;
const MAX_NOTE_TEXT = 1500;
const MAX_STAGE_TEXT = 200;
const STAGE_MARK = { done: '✓', active: '▶', todo: '○' };
const STAGE_WORD = { done: 'завершён', active: 'в работе', todo: 'впереди' };

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatStages(info) {
  const lines = [];
  const stages = (info && info.stages) || [];
  if (!stages.length && info && info.plan_skipped) {
    lines.push('План этапов для этого проекта пользователь отключил — составлять его не нужно.');
    return lines;
  }
  if (!stages.length) {
    lines.push('У проекта нет плана этапов. По правилу из ~/.claude/CLAUDE.md план обязателен: его нужно составить в начале работы (PUT /api/stages), если только пользователь прямо не попросил обойтись без плана.');
    return lines;
  }
  const progress = info.progress !== null && info.progress !== undefined ? `, готовность ${info.progress}%` : '';
  lines.push(`Этапы проекта (${stages.length}${progress}); в отчёте поле stage — точное название этапа:`);
  stages.forEach((st, i) => {
    let desc = (st.description || '').replace(/\s+/g, ' ').trim();
    if (desc.length > MAX_STAGE_TEXT) desc = desc.slice(0, MAX_STAGE_TEXT) + '…';
    lines.push(`  ${STAGE_MARK[st.status] || '○'} ${i + 1}. ${st.title} — ${STAGE_WORD[st.status] || st.status}${desc ? `: ${desc}` : ''}`);
  });
  return lines;
}

function formatNotes(project, sessionId, notes, info) {
  const lines = [];
  lines.push(`[Agent Dashboard ${BASE_URL}] Проект в дашборде: «${project}»${sessionId ? `, session_id этой сессии: ${sessionId}` : ''}.`);
  lines.push(...formatStages(info));
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
  lines.push(`Отметка о выполнении правки: curl -s -m 3 -X PATCH ${BASE_URL}/api/notes/<id> -H 'Content-Type: application/json' -d '{"status":"done","done_by":"claude"}'`);
  return lines.join('\n');
}

async function main() {
  const input = parseJson(await readStdin()) || {};
  const project = projectName(projectDir(input));
  const enc = encodeURIComponent(project);
  const [notes, info] = await Promise.all([
    request('GET', `/api/notes?project=${enc}&status=open`, null, 1500),
    // 404 — проект ещё не встречался в дашборде, это не ошибка
    request('GET', `/api/projects/${enc}?tasks=0`, null, 1500).catch(() => null),
  ]);
  // API отдаёт свежие сверху, агенту удобнее очередь от старых к новым
  notes.reverse();
  return formatNotes(project, input.session_id, notes, info) + '\n';
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
