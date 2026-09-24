'use strict';
const fs = require('fs');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TASK = 5000;
const MAX_SUMMARY = 4000;

function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* недописанная строка */ }
  }
  return out;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Текст пользовательского сообщения без служебных вставок Claude Code.
// Возвращает { text } для настоящего запроса, { command } для слэш-команды без аргументов, null — пропустить.
function userText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  const msg = entry.message;
  if (!msg || msg.role !== 'user') return null;
  let text;
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    if (msg.content.some((c) => c && c.type === 'tool_result')) return null;
    text = msg.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  } else {
    return null;
  }

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  if (/<local-command-(stdout|stderr|caveat)>/.test(text) || /^\s*Caveat: The messages below/.test(text)) return null;
  if (/^\s*\[Request interrupted by user/.test(text)) return null;

  const cmd = text.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  if (cmd) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1];
    if (args && args.trim()) return { text: `/${cmd[1]} ${args.trim()}` };
    return { command: `/${cmd[1]}` };
  }
  text = text.trim();
  return text ? { text } : null;
}

function assistantTexts(entry) {
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === 'text' && c.text && c.text.trim()).map((c) => c.text.trim());
}

function toolUses(entry) {
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === 'tool_use');
}

// Транскрипты сабагентов лежат рядом: <session>.jsonl → <session>/subagents/*.jsonl
function subagentTranscripts(transcriptPath) {
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Разбирает транскрипт Claude Code (JSONL).
 * @returns {{ task: string, summary: string, files: string[] }}
 *   task    — первый запрос пользователя,
 *   summary — последний текстовый ответ агента в основной ветке,
 *   files   — file_path всех успешных Edit/Write/MultiEdit (+NotebookEdit), без дублей, в порядке появления.
 */
function parseTranscript(transcriptPath, { projectDir } = {}) {
  const main = readJsonl(transcriptPath);
  const entries = main.concat(...subagentTranscripts(transcriptPath).map(readJsonl));

  let task = '';
  let fallbackCommand = '';
  let summary = '';
  const pathByToolId = new Map();
  const failedToolIds = new Set();
  const order = [];

  for (const entry of main) {
    if (task) break;
    const u = userText(entry);
    if (!u) continue;
    if (u.text) task = u.text;
    else if (!fallbackCommand) fallbackCommand = u.command;
  }

  for (const entry of entries) {
    if (entry.type === 'assistant') {
      for (const use of toolUses(entry)) {
        if (!EDIT_TOOLS.has(use.name) || !use.input) continue;
        const p = use.input.file_path || use.input.notebook_path;
        if (typeof p !== 'string' || !p) continue;
        pathByToolId.set(use.id, p);
        order.push({ id: use.id, path: p });
      }
    } else if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
      for (const c of entry.message.content) {
        if (c && c.type === 'tool_result' && c.is_error && c.tool_use_id) failedToolIds.add(c.tool_use_id);
      }
    }
  }
  for (const entry of main) {
    if (entry.type === 'assistant' && !entry.isSidechain) {
      const texts = assistantTexts(entry);
      if (texts.length) summary = texts.join('\n\n');
    }
  }

  const root = projectDir ? path.resolve(projectDir) : null;
  const seen = new Set();
  const files = [];
  for (const { id, path: p } of order) {
    if (failedToolIds.has(id)) continue;
    let shown = p;
    if (root && path.isAbsolute(p)) {
      const rel = path.relative(root, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) shown = rel.split(path.sep).join('/');
    }
    if (!seen.has(shown)) { seen.add(shown); files.push(shown); }
  }

  return {
    task: truncate(task || fallbackCommand, MAX_TASK),
    summary: truncate(summary, MAX_SUMMARY),
    files,
  };
}

module.exports = { parseTranscript, userText };
