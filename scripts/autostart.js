#!/usr/bin/env node
'use strict';
/**
 * Автозапуск сервера дашборда при входе в систему.
 *
 *   node scripts/autostart.js            установить и сразу запустить (уже запущенный дашборд
 *                                        перезапускается — так подхватывается обновлённый код)
 *   node scripts/autostart.js --remove   убрать автозапуск и остановить сервер
 *   node scripts/autostart.js --print    только показать, что будет установлено
 *                             --print --platform=darwin|linux|win32   … для другой ОС
 *
 * macOS   — LaunchAgent  ~/Library/LaunchAgents/com.agent-dashboard.plist (launchd, перезапуск при падении)
 * Linux   — systemd --user сервис agent-dashboard.service (если systemd нет — ~/.config/autostart/*.desktop)
 * Windows — скрипт agent-dashboard.vbs в папке «Автозагрузка» (запускает node без окна)
 *
 * Используется тот же node, которым запущен скрипт: под него собран better-sqlite3,
 * а у launchd/systemd нет PATH из вашего shell (nvm, volta и т. п.).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const NODE = process.execPath;
const PORT = Number(process.env.PORT) || 4000;
const LABEL = 'com.agent-dashboard';
const LOG = path.join(ROOT, 'data', 'server.log');

const args = new Set(process.argv.slice(2));
const REMOVE = args.has('--remove');
const PRINT = args.has('--print');
const platformArg = [...args].find((a) => a.startsWith('--platform='));
const PLATFORM = PRINT && platformArg ? platformArg.split('=')[1] : process.platform;

function run(cmd, argv, { ignoreError = false } = {}) {
  try {
    return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    if (ignoreError) return null;
    const details = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`${cmd} ${argv.join(' ')}: ${details}`);
  }
}

function write(file, content, encoding = 'utf8') {
  if (PRINT) {
    console.log(`--- ${file}\n${content}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // WSH читает .vbs в ANSI-кодировке, а UTF-16LE с BOM — всегда правильно (кириллица в пути)
  fs.writeFileSync(file, encoding === 'utf16le' ? Buffer.from('\ufeff' + content.replace(/\n/g, '\r\n'), 'utf16le') : content);
  console.log(`✓ записан ${file}`);
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- macOS ----------
function mac() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid ? process.getuid() : 0}`;
  if (!PRINT) run('launchctl', ['bootout', `${domain}/${LABEL}`], { ignoreError: true });
  if (REMOVE) {
    fs.rmSync(plist, { force: true });
    console.log(`✓ автозапуск убран, сервер остановлен (${plist})`);
    return;
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  write(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE)}</string>
    <string>${xmlEscape(SERVER)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>${PORT}</string><key>AGENT_DASHBOARD_SUPERVISED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xmlEscape(LOG)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(LOG)}</string>
</dict>
</plist>
`);
  if (PRINT) return;
  if (run('launchctl', ['bootstrap', domain, plist], { ignoreError: true }) === null) {
    run('launchctl', ['load', '-w', plist]);
  }
  console.log('✓ LaunchAgent загружен: сервер запущен и будет стартовать при каждом входе в систему');
  console.log(`  лог: ${LOG}`);
  console.log(`  остановить до перезагрузки: launchctl bootout ${domain}/${LABEL}`);
}

// ---------- Linux ----------
function hasSystemdUser() {
  return run('systemctl', ['--user', 'show-environment'], { ignoreError: true }) !== null;
}

function linux() {
  const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  const unit = path.join(unitDir, 'agent-dashboard.service');
  const desktop = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'agent-dashboard.desktop');

  if (REMOVE) {
    if (hasSystemdUser()) run('systemctl', ['--user', 'disable', '--now', 'agent-dashboard.service'], { ignoreError: true });
    fs.rmSync(unit, { force: true });
    fs.rmSync(desktop, { force: true });
    if (hasSystemdUser()) run('systemctl', ['--user', 'daemon-reload'], { ignoreError: true });
    console.log('✓ автозапуск убран');
    return;
  }

  const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  if (PRINT || hasSystemdUser()) {
    write(unit, `[Unit]
Description=Agent Dashboard для Claude Code (http://localhost:${PORT})
After=network.target

[Service]
ExecStart=${q(NODE)} ${q(SERVER)}
WorkingDirectory=${ROOT}
Environment=PORT=${PORT}
Environment=AGENT_DASHBOARD_SUPERVISED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
    if (PRINT) return;
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'agent-dashboard.service']);
    run('systemctl', ['--user', 'restart', 'agent-dashboard.service']);
    console.log('✓ systemd --user сервис включён и запущен; стартует при входе в систему');
    console.log('  статус: systemctl --user status agent-dashboard   ·   лог: journalctl --user -u agent-dashboard -f');
    console.log('  чтобы сервер работал и без входа в систему: loginctl enable-linger $USER');
    return;
  }

  // Нет systemd (например, WSL без systemd): автозапуск графической сессии
  const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  write(desktop, `[Desktop Entry]
Type=Application
Name=Agent Dashboard
Exec=sh -c "cd ${sh(ROOT)} && exec ${sh(NODE)} ${sh(SERVER)} >> ${sh(LOG)} 2>&1"
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
  startDetached();
  console.log('✓ systemd --user недоступен — добавлен XDG-автозапуск (сработает при входе в графическую сессию).');
  console.log('  В WSL без systemd добавьте в ~/.bashrc или ~/.profile:');
  console.log(`  (curl -s -m 1 localhost:${PORT}/api/health >/dev/null || nohup ${sh(NODE)} ${sh(SERVER)} >> ${sh(LOG)} 2>&1 &)`);
}

// ---------- Windows ----------
function windows() {
  const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = path.join(startup, 'agent-dashboard.vbs');
  if (REMOVE) {
    fs.rmSync(vbs, { force: true });
    console.log(`✓ автозапуск убран, сервер остановлен (${vbs})`);
    return;
  }
  const vq = (s) => `""${s.replace(/"/g, '')}""`;
  write(vbs, `' Agent Dashboard: запуск сервера без окна при входе в Windows
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${ROOT.replace(/"/g, '')}"
sh.Environment("Process")("PORT") = "${PORT}"
sh.Run "${vq(NODE)} ${vq(SERVER)}", 0, False
`, 'utf16le');
  if (PRINT) return;
  spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('✓ сервер запущен и будет стартовать при каждом входе в Windows (папка «Автозагрузка»)');
}

// ---------- остановка уже запущенного дашборда ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Наш ли сервер слушает порт: новая версия называет себя, первая отвечала ровно {"ok":true}
const isDashboard = (h) => !!h && (h.app === 'agent-dashboard' || (h.ok === true && Object.keys(h).length === 1));

// PID процесса, слушающего порт (для первой версии, которая не сообщала свой pid)
function pidsOnPort() {
  if (process.platform === 'win32') {
    // столбцы: протокол, локальный адрес, внешний адрес, состояние, PID; состояние бывает
    // локализовано, поэтому слушающий сокет узнаём по внешнему адресу 0.0.0.0:0 / [::]:0
    const out = run('netstat', ['-ano', '-p', 'tcp'], { ignoreError: true }) || '';
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 5 && c[1].endsWith(`:${PORT}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(c[2]))
      .map((c) => Number(c[c.length - 1])))];
  }
  const lsof = run('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { ignoreError: true });
  if (lsof) return lsof.split(/\s+/).filter(Boolean).map(Number);
  const ss = run('ss', ['-ltnpH', `sport = :${PORT}`], { ignoreError: true }) || '';
  return [...ss.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

async function stopRunningServer() {
  const h = await health();
  if (!h) return;
  if (!isDashboard(h)) throw new Error(`порт ${PORT} занят другой программой — освободите его или задайте PORT`);
  const pids = (h.pid ? [h.pid] : pidsOnPort()).filter((pid) => pid > 0 && pid !== process.pid);
  if (!pids.length) {
    console.log(`! дашборд на порту ${PORT} уже запущен, но его процесс найти не удалось — остановите его вручную`);
    return;
  }
  for (const pid of pids) {
    try { process.kill(pid); } catch { /* уже завершился */ }
  }
  for (let i = 0; i < 40; i++) {
    if (!(await health())) {
      console.log(`✓ остановлен запущенный дашборд (pid ${pids.join(', ')})`);
      return;
    }
    await sleep(150);
  }
  console.log(`! дашборд (pid ${pids.join(', ')}) не остановился — закройте процесс node вручную`);
}

async function waitForStart() {
  for (let i = 0; i < 40; i++) {
    const h = await health();
    if (h && h.app === 'agent-dashboard') return h;
    await sleep(250);
  }
  return null;
}

function startDetached() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  spawn(NODE, [SERVER], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(PORT) } }).unref();
}

(async () => {
  if (!PRINT) {
    // сначала гасим менеджер автозапуска, чтобы он не поднял старый процесс обратно
    if (PLATFORM === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { ignoreError: true });
    if (PLATFORM === 'linux' && hasSystemdUser()) run('systemctl', ['--user', 'stop', 'agent-dashboard.service'], { ignoreError: true });
    await stopRunningServer();
  }
  if (PLATFORM === 'darwin') mac();
  else if (PLATFORM === 'win32') windows();
  else linux();
  if (!REMOVE && !PRINT) {
    const h = await waitForStart();
    if (h) console.log(`\n✓ Дашборд работает: http://localhost:${PORT} (версия ${h.version}, pid ${h.pid})`);
    else console.log(`\n! Сервер не ответил за 10 с — посмотрите лог: ${LOG}`);
  }
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
