#!/usr/bin/env node
'use strict';
/**
 * Хук Stop для Claude Code: план этапов обязателен.
 *
 * Когда агент заканчивает ответ, хук проверяет проект в дашборде. Если в этой сессии
 * менялись файлы, а плана этапов у проекта нет (и пользователь не отказался от него),
 * хук возвращает Claude напоминание — и тот составляет план, прежде чем закончить.
 * Повторно в том же ответе не срабатывает (stop_hook_active), сервер выключен — молчит.
 */
const { BASE_URL, debug, readStdin, parseJson, projectDir, projectName, request } = require('./lib/common');
const { parseTranscript } = require('./lib/transcript');

// project внутри JSON в heredoc: экранируем как строку JSON
const jsonStr = (s) => JSON.stringify(String(s)).slice(1, -1);

function reminder(project) {
  const p = jsonStr(project);
  return [
    `[Agent Dashboard] В этой сессии менялись файлы проекта «${project}», а плана этапов у проекта в дашборде нет.`,
    'По правилу из ~/.claude/CLAUDE.md план обязателен: составь 3–7 этапов всего проекта (что уже сделано — done, что сейчас — active, что впереди — todo, к каждому — короткое описание задач этапа) и отправь его:',
    '',
    `curl -s -m 3 -X PUT ${BASE_URL}/api/stages -H 'Content-Type: application/json' --data-binary @- <<'JSON' || true`,
    `{"project": "${p}", "stages": [{"title": "…", "description": "…", "status": "done"}, {"title": "…", "description": "…", "status": "active"}, {"title": "…", "description": "…", "status": "todo"}]}`,
    'JSON',
    '',
    'Если пользователь в этой сессии прямо просил план не составлять — не составляй, а отметь отказ, чтобы напоминание больше не появлялось:',
    `curl -s -m 3 -X PUT ${BASE_URL}/api/stages -H 'Content-Type: application/json' --data-binary @- <<'JSON' || true`,
    `{"project": "${p}", "skip": true}`,
    'JSON',
  ].join('\n');
}

async function main() {
  const input = parseJson(await readStdin()) || {};
  if (input.stop_hook_active) return null;
  const dir = projectDir(input);
  const project = projectName(dir);

  let info = null;
  try {
    info = await request('GET', `/api/projects/${encodeURIComponent(project)}?tasks=0`, null, 1500);
  } catch (err) {
    // 404 «Проект не найден» — проекта ещё нет в дашборде, плана тоже.
    // Сервер выключен или старый (без этого API) — ничего не требуем.
    if (!/HTTP 404/.test(err.message) || /Нет такого API/.test(err.message)) {
      debug(err.message);
      return null;
    }
  }
  if (info && ((info.stages && info.stages.length) || info.plan_skipped)) return null;

  // план требуем только там, где агент действительно работал с файлами
  if (!input.transcript_path) return null;
  const { files } = parseTranscript(input.transcript_path, { projectDir: dir });
  if (!files.length) return null;

  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reminder(project) } };
}

if (require.main === module) {
  main()
    .then((out) => {
      if (!out) return process.exit(0);
      process.stdout.write(JSON.stringify(out), () => process.exit(0));
    })
    .catch((err) => {
      debug(err && err.message ? err.message : err);
      process.exit(0);
    });
}

module.exports = { reminder };
