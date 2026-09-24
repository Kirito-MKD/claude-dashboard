#!/usr/bin/env node
'use strict';
/**
 * Подключает дашборд к Claude Code:
 *   1. добавляет хуки SessionStart/SessionEnd в ~/.claude/settings.json (остальные настройки не трогает);
 *   2. добавляет в ~/.claude/CLAUDE.md инструкцию отчитываться в дашборд.
 * Повторный запуск ничего не дублирует. Перед изменением файлов делается резервная копия.
 *
 *   node scripts/install.js               установить
 *   node scripts/install.js --uninstall   убрать только то, что добавил этот скрипт
 *   node scripts/install.js --dry-run     показать, что изменится, ничего не записывая
 *   --claude-dir <path>                   другой каталог конфигурации (по умолчанию $CLAUDE_CONFIG_DIR или ~/.claude)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOOK_EVENTS = {
  SessionStart: { script: 'session-start.js', timeout: 10 },
  // таймаут поднимает общий бюджет SessionEnd с 1.5 с; сам хук отвечает мгновенно
  SessionEnd: { script: 'session-end.js', timeout: 5 },
};
const MD_START = '<!-- agent-dashboard:start -->';
const MD_END = '<!-- agent-dashboard:end -->';
const PORT = Number(process.env.PORT) || 4000;

const CLAUDE_MD_BLOCK = `${MD_START}
## Дашборд агентов (localhost:${PORT})

В конце каждой задачи отправь curl POST на localhost:${PORT}/api/tasks с кратким summary и статусом проекта. Выполненные правки отметь через PATCH.

- \`project\` — имя корневой папки проекта (оно же указано в контексте дашборда в начале сессии), \`session_id\` — из того же контекста, если он есть.
- \`task\` — исходный запрос пользователя в 1–2 фразах; \`summary\` — что сделано, кратко; \`files\` — изменённые файлы; \`status\` — состояние проекта одной строкой (что готово / что дальше).
- Если сервер не отвечает — не повторяй запрос и не останавливайся из-за этого.

\`\`\`bash
curl -s -m 3 -X POST http://localhost:${PORT}/api/tasks -H 'Content-Type: application/json' --data-binary @- <<'JSON' || true
{"project": "my-app", "session_id": "…", "task": "Добавить экспорт в CSV", "summary": "Кнопка экспорта + эндпоинт /export, тест на формат", "files": ["src/export.ts", "src/App.tsx"], "status": "MVP готов; дальше — авторизация"}
JSON
\`\`\`

Открытые правки пользователя (текст, голос, скриншоты) приходят в контексте сессии с номерами. Выполненную правку отметь:

\`\`\`bash
curl -s -m 3 -X PATCH http://localhost:${PORT}/api/notes/<id> -H 'Content-Type: application/json' -d '{"status":"done"}' || true
\`\`\`
${MD_END}`;

// ---------- аргументы ----------
function parseArgs(argv) {
  const args = { uninstall: false, dryRun: false, claudeDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') args.uninstall = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--claude-dir') args.claudeDir = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return args;
}

// ---------- settings.json ----------
const toPosix = (p) => p.split(path.sep).join('/');
const hookCommand = (script) => `node "${toPosix(path.join(ROOT, 'hooks', script))}"`;

// Наш ли это обработчик: тот же скрипт по текущему пути или по старому пути папки дашборда
function isOurHandler(handler, script) {
  if (!handler || typeof handler.command !== 'string') return false;
  const cmd = handler.command.replace(/\\/g, '/');
  if (cmd.includes(toPosix(path.join(ROOT, 'hooks', script)))) return true;
  return new RegExp(`(agent|claude)-dashboard[^"']*/hooks/${script.replace('.', '\\.')}`).test(cmd);
}

function withoutOurHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const [event, { script }] of Object.entries(HOOK_EVENTS)) {
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isOurHandler(h, script));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

// Если наш обработчик уже есть — обновляем его на месте (путь мог смениться), иначе добавляем
// новую группу в конец. Лишние копии удаляем. Чужие хуки и группы не трогаем.
function withOurHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  for (const [event, { script, timeout }] of Object.entries(HOOK_EVENTS)) {
    const desired = { type: 'command', command: hookCommand(script), timeout };
    let placed = false;
    const groups = (Array.isArray(next.hooks[event]) ? next.hooks[event] : [])
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const handlers = [];
        for (const h of group.hooks) {
          if (!isOurHandler(h, script)) handlers.push(h);
          else if (!placed) { handlers.push({ ...h, ...desired }); placed = true; }
        }
        return { ...group, hooks: handlers };
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length);
    if (!placed) groups.push({ hooks: [desired] });
    next.hooks[event] = groups;
  }
  return next;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, raw: null };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { settings: {}, raw };
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} — некорректный JSON (${e.message}). Исправьте файл и запустите снова; он не был изменён.`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${file} должен содержать JSON-объект; файл не был изменён.`);
  }
  return { settings, raw };
}

// ---------- CLAUDE.md ----------
function stripBlock(text) {
  const start = text.indexOf(MD_START);
  const end = text.indexOf(MD_END);
  if (start === -1 || end === -1 || end < start) return text;
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(end + MD_END.length).replace(/^\n+/, '');
  return before && after ? `${before}\n\n${after}` : before || after;
}

function withBlock(text) {
  const base = stripBlock(text).replace(/\s+$/, '');
  return (base ? `${base}\n\n` : '') + CLAUDE_MD_BLOCK + '\n';
}

// ---------- запись ----------
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeWithBackup(file, content, original, dryRun) {
  if (dryRun) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (original !== null) {
    backup = `${file}.bak-${stamp()}`;
    fs.writeFileSync(backup, original);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return backup;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const claudeDir = path.resolve(args.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const settingsFile = path.join(claudeDir, 'settings.json');
  const mdFile = path.join(claudeDir, 'CLAUDE.md');
  const verb = args.dryRun ? '(dry-run) ' : '';

  // settings.json
  const { settings, raw } = readSettings(settingsFile);
  const nextSettings = args.uninstall ? withoutOurHooks(settings) : withOurHooks(settings);
  if (JSON.stringify(nextSettings) === JSON.stringify(settings)) {
    console.log(`✓ ${settingsFile}: ${args.uninstall ? 'хуков дашборда нет' : 'хуки уже настроены'}, без изменений`);
  } else {
    const content = JSON.stringify(nextSettings, null, 2) + '\n';
    const backup = writeWithBackup(settingsFile, content, raw, args.dryRun);
    console.log(`✓ ${verb}${settingsFile}: ${args.uninstall ? 'хуки дашборда удалены' : 'добавлены хуки SessionStart и SessionEnd'}`);
    if (backup) console.log(`  резервная копия: ${backup}`);
    if (args.dryRun) console.log(content);
  }

  // CLAUDE.md
  const mdRaw = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : null;
  const mdText = mdRaw || '';
  let mdNext = args.uninstall ? stripBlock(mdText) : withBlock(mdText);
  if (args.uninstall && mdNext && !mdNext.endsWith('\n')) mdNext += '\n';
  if (mdNext === mdText || (args.uninstall && mdRaw === null)) {
    console.log(`✓ ${mdFile}: ${args.uninstall ? 'блока дашборда нет' : 'инструкция уже на месте'}, без изменений`);
  } else {
    const backup = writeWithBackup(mdFile, mdNext, mdRaw, args.dryRun);
    console.log(`✓ ${verb}${mdFile}: ${args.uninstall ? 'блок дашборда удалён' : mdRaw && mdRaw.includes(MD_START) ? 'инструкция обновлена' : 'добавлена инструкция для агентов'}`);
    if (backup) console.log(`  резервная копия: ${backup}`);
  }

  if (!args.uninstall && !args.dryRun) {
    console.log(`\nГотово. Хуки заработают в новых сессиях Claude Code (проверить: /hooks).`);
    console.log(`Запустить сервер: npm start   ·   автозапуск при входе: npm run autostart`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}

module.exports = { withOurHooks, withoutOurHooks, withBlock, stripBlock, hookCommand, CLAUDE_MD_BLOCK };
