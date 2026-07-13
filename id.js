'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const config = require('./config');
const { parseIncoming } = require('./msg');
const { handleCommand } = require('./pair');
const { initializeFromGithub, matchReply } = require('./reply');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    fs.mkdirSync(config.SESSION_DIR, { recursive: true });
  }

  cleanId(value) {
    const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    if (!id || !/^[a-z0-9]/.test(id)) throw new Error('Invalid session ID. Use letters and numbers.');
    return id;
  }

  publicState(session) {
    return {
      id: session.id,
      status: session.status,
      method: session.method,
      qr: session.qr || null,
      pairCode: session.pairCode || null,
      user: session.user ? { id: session.user.id, name: session.user.name } : null,
      error: session.error || null,
      updatedAt: session.updatedAt
    };
  }

  list() { return [...this.sessions.values()].map(s => this.publicState(s)); }
  get(id) { const s = this.sessions.get(this.cleanId(id)); return s ? this.publicState(s) : null; }

  update(session, patch) {
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.emit('update', this.publicState(session));
  }

  async create(rawId, method = 'qr', phone = '') {
    const id = this.cleanId(rawId);
    if (!['qr', 'pair'].includes(method)) throw new Error('Method must be qr or pair.');
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      if (existing.status === 'open' || existing.status === 'connecting' || existing.status === 'qr-ready') return this.publicState(existing);
      await this.stop(id, false);
    }
    if (this.sessions.size >= config.MAX_SESSIONS) throw new Error(`Maximum ${config.MAX_SESSIONS} sessions allowed.`);
    const number = String(phone).replace(/\D/g, '');
    if (method === 'pair' && (number.length < 8 || number.length > 15)) throw new Error('Enter phone number with country code (digits only).');

    const session = {
      id, method, phone: number, status: 'connecting', qr: null, pairCode: null,
      user: null, error: null, socket: null, reconnectTimer: null, intentionallyClosed: false,
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(id, session);
    await this.connect(session);
    return this.publicState(session);
  }

  async connect(session) {
    const authPath = path.join(config.SESSION_DIR, session.id);
    fs.mkdirSync(authPath, { recursive: true });
    await initializeFromGithub(session.id).catch(error =>
      logger.warn({ error, sessionId: session.id }, 'GitHub auto replies could not be restored')
    );
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (_) { version = undefined; }
    session.intentionallyClosed = false;
    const socket = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu(config.BOT_NAME),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      getMessage: async () => undefined
    });
    session.socket = socket;
    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && session.method === 'qr') this.update(session, { qr, status: 'qr-ready', error: null });
      if (connection === 'connecting') this.update(session, { status: 'connecting' });
      if (connection === 'open') this.update(session, { status: 'open', qr: null, pairCode: null, user: socket.user, error: null });
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error).output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.update(session, { status: loggedOut ? 'logged-out' : 'closed', qr: null, error: lastDisconnect?.error?.message || null });
        if (!loggedOut && !session.intentionallyClosed) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(() => this.connect(session).catch(err => this.update(session, { status: 'error', error: err.message })), 3500);
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) {
        if (!raw.message || raw.key.remoteJid === 'status@broadcast') continue;
        const message = parseIncoming(raw);
        if (!message.isCommand) {
          // Never auto-reply to the bot's own outgoing messages (prevents loops).
          if (message.fromMe) continue;
          const automaticReply = matchReply(session.id, message.body);
          if (automaticReply) {
            await socket.sendMessage(message.chat, { text: automaticReply }, { quoted: raw }).catch(error =>
              logger.warn({ error, sessionId: session.id }, 'auto reply failed')
            );
          }
          continue;
        }
        const senderNumber = message.sender.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (!config.PUBLIC_MODE && !config.OWNER_NUMBERS.includes(senderNumber)) continue;
        if (config.AUTO_READ) await socket.readMessages([raw.key]).catch(() => {});
        await handleCommand(socket, message, session.id).catch(error => logger.error({ error }, 'command failed'));
      }
    });

    if (session.method === 'pair' && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await socket.requestPairingCode(session.phone);
          this.update(session, { pairCode: code?.match(/.{1,4}/g)?.join('-') || code, status: 'pair-ready', error: null });
        } catch (error) { this.update(session, { status: 'error', error: `Pairing failed: ${error.message}` }); }
      }, 1200);
    }
    return socket;
  }

  async stop(rawId, removeFiles = false) {
    const id = this.cleanId(rawId);
    const session = this.sessions.get(id);
    if (session) {
      session.intentionallyClosed = true;
      clearTimeout(session.reconnectTimer);
      try { session.socket?.end?.(new Error('Session stopped')); } catch (_) {}
      this.sessions.delete(id);
    }
    if (removeFiles) fs.rmSync(path.join(config.SESSION_DIR, id), { recursive: true, force: true });
  }

  async restore() {
    const directories = fs.readdirSync(config.SESSION_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory());
    for (const entry of directories) {
      try { await this.create(entry.name, 'qr'); }
      catch (error) { logger.warn({ id: entry.name, error: error.message }, 'could not restore session'); }
    }
  }
}

module.exports = new SessionManager();
