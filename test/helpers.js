'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

function tmpDir(prefix = 'agent-dashboard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer() {
  const dataDir = tmpDir();
  const ctx = createApp({ dataDir });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...ctx,
    base,
    port: server.address().port,
    async stop() {
      ctx.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Минимальный PNG 1×1
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

module.exports = { tmpDir, startServer, PNG_1PX };
