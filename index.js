'use strict';

const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./config');
const sessions = require('./id');
const { loadCatalog } = require('./pair');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'main.html')));
app.get('/health', (_req, res) => res.json({ ok: true, bot: config.BOT_NAME, sessions: sessions.list().length }));
app.get('/api/config', (_req, res) => res.json({ botName: config.BOT_NAME, prefix: config.PREFIX, maxSessions: config.MAX_SESSIONS }));
app.get('/api/sessions', (_req, res) => res.json({ success: true, sessions: sessions.list() }));
app.get('/api/sessions/:id', (req, res) => {
  try { const session = sessions.get(req.params.id); session ? res.json({ success: true, session }) : res.status(404).json({ success: false, error: 'Session not found' }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.post('/api/sessions', async (req, res) => {
  try {
    const method = req.body.method || 'qr';
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    const id = req.body.id || (method === 'pair' ? phone : '');
    res.status(201).json({ success: true, session: await sessions.create(id, method, phone) });
  }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.delete('/api/sessions/:id', async (req, res) => {
  try { await sessions.stop(req.params.id, true); res.json({ success: true }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.get('/api/sessions/:id/qr', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session?.qr) return res.status(404).json({ success: false, error: 'QR is not ready' });
    res.json({ success: true, dataUrl: await QRCode.toDataURL(session.qr, { width: 360, margin: 2, errorCorrectionLevel: 'M' }) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

const server = app.listen(config.PORT, config.HOST, async () => {
  console.log(`\n${config.BOT_NAME} dashboard: http://localhost:${config.PORT}`);
  await sessions.restore();
  loadCatalog().then(items => console.log(`David API catalog: ${items.length} endpoints loaded`)).catch(error => console.warn(`API catalog: ${error.message}`));
});

async function shutdown() {
  server.close();
  await Promise.all(sessions.list().map(session => sessions.stop(session.id, false)));
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
