#!/usr/bin/env node
'use strict';
/**
 * Хук SessionEnd для Claude Code.
 *
 * Читает из stdin { session_id, transcript_path, cwd }, берёт из транскрипта первый запрос
 * пользователя, последний ответ агента и file_path всех Edit/Write/MultiEdit, и отправляет
 * это в дашборд (POST /api/tasks). Если дашборд не запущен — молча выходит.
 *
 * Claude Code даёт хукам SessionEnd ~1.5 с и может прервать их при выходе, а транскрипт
 * дописывается асинхронно. Поэтому основной процесс сразу отпускает Claude Code, а разбор
 * и отправку делает отсоединённый фоновый процесс, выждав секунду.
 *
 * AGENT_DASHBOARD_HOOK_SYNC=1 — выполнить всё в текущем процессе без задержки (для тестов),
 * AGENT_DASHBOARD_DEBUG=1 — печатать ошибки в stderr.
 */
const { spawn } = require('child_process');
const { debug, readStdin, parseJson, projectDir, projectName, request } = require('./lib/common');
const { parseTranscript } = require('./lib/transcript');

const FLUSH_DELAY_MS = 1200;

async function report(input) {
  if (!input || !input.transcript_path) return;
  const dir = input.project_dir || projectDir(input);
  const { task, summary, files } = parseTranscript(input.transcript_path, { projectDir: dir });
  if (!task && !files.length) {
    debug('пустая сессия — нечего отправлять');
    return;
  }
  const saved = await request('POST', '/api/tasks', {
    project: projectName(dir),
    task,
    summary,
    files,
    session_id: input.session_id || null,
    source: 'hook',
  }, 3000);
  debug('отправлено', saved && saved.id);
}

async function main() {
  if (process.argv[2] === '--worker') {
    const input = parseJson(Buffer.from(process.argv[3] || '', 'base64').toString('utf8'));
    await new Promise((r) => setTimeout(r, FLUSH_DELAY_MS));
    return report(input);
  }

  const input = parseJson(await readStdin());
  if (!input) return;
  // CLAUDE_PROJECT_DIR передаём явно: у фонового процесса окружение то же, но так надёжнее
  const payload = { ...input, project_dir: projectDir(input) };

  if (process.env.AGENT_DASHBOARD_HOOK_SYNC === '1') return report(payload);

  const child = spawn(process.execPath, [__filename, '--worker', Buffer.from(JSON.stringify(payload)).toString('base64')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

main()
  .catch((err) => debug(err && err.message ? err.message : err))
  .finally(() => process.exit(0));
