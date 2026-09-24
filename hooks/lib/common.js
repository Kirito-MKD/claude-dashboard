'use strict';
const path = require('path');

const BASE_URL = (process.env.AGENT_DASHBOARD_URL || `http://127.0.0.1:${process.env.AGENT_DASHBOARD_PORT || 4000}`).replace(/\/+$/, '');
const DEBUG = process.env.AGENT_DASHBOARD_DEBUG === '1';

function debug(...args) {
  if (DEBUG) console.error('[agent-dashboard]', ...args);
}

// Хуки получают JSON на stdin. Если stdin не пришёл (ручной запуск) — не висим вечно.
function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => { process.stdin.pause(); resolve(data); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Корень проекта: CLAUDE_PROJECT_DIR не меняется, даже если Claude сделал `cd` в подпапку,
// а cwd из входа хука — меняется. Поэтому сначала он.
function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

function projectName(dir) {
  return path.basename(path.resolve(dir)) || 'unknown';
}

async function request(method, urlPath, body, timeoutMs = 2000) {
  const res = await fetch(BASE_URL + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

module.exports = { BASE_URL, debug, readStdin, parseJson, projectDir, projectName, request };
