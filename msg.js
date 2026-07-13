'use strict';

const config = require('./config');

function unwrap(message = {}) {
  if (message.ephemeralMessage) return unwrap(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrap(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrap(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage) return unwrap(message.documentWithCaptionMessage.message);
  return message;
}

function textOf(message = {}) {
  const m = unwrap(message);
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}

function parseIncoming(raw) {
  const body = textOf(raw.message).trim();
  const prefix = config.PREFIX;
  const isCommand = body.startsWith(prefix);
  const withoutPrefix = isCommand ? body.slice(prefix.length).trim() : '';
  const [command = '', ...parts] = withoutPrefix.split(/\s+/);
  return {
    raw,
    body,
    isCommand,
    command: command.toLowerCase(),
    args: parts,
    query: parts.join(' '),
    chat: raw.key.remoteJid,
    sender: raw.key.participant || raw.key.remoteJid,
    fromMe: Boolean(raw.key.fromMe),
    isGroup: raw.key.remoteJid?.endsWith('@g.us'),
    id: raw.key.id,
    pushName: raw.pushName || 'User'
  };
}

function clip(value, length = 3500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > length ? `${text.slice(0, length)}\n…(truncated)` : text;
}

function collectUrls(value, output = [], seen = new Set()) {
  if (output.length >= 40 || value == null) return output;
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const url of matches) if (!seen.has(url)) { seen.add(url); output.push(url); }
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output, seen);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, output, seen);
  }
  return output;
}

function pickMedia(data) {
  const preferred = ['download', 'downloadUrl', 'download_url', 'video', 'audio', 'image', 'url', 'link', 'src'];
  const walk = value => {
    if (!value || typeof value !== 'object') return null;
    for (const key of preferred) {
      const candidate = value[key];
      if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') { const found = walk(nested); if (found) return found; }
    }
    return null;
  };
  return walk(data) || collectUrls(data)[0] || null;
}

async function sendApiResult(sock, jid, quoted, data, endpoint) {
  const media = pickMedia(data);
  const lowered = `${endpoint} ${media || ''}`.toLowerCase();
  const caption = `*${config.BOT_NAME}*\n${clip(data, 2800)}`;
  if (media) {
    try {
      if (/\.(jpg|jpeg|png|webp)(\?|$)|image|wallpaper|pinterest/.test(lowered))
        return await sock.sendMessage(jid, { image: { url: media }, caption }, { quoted });
      if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)|mp3|audio|music/.test(lowered))
        return await sock.sendMessage(jid, { audio: { url: media }, mimetype: 'audio/mpeg' }, { quoted });
      if (/\.(mp4|mkv|webm|mov)(\?|$)|mp4|video|tiktok|facebook|instagram/.test(lowered))
        return await sock.sendMessage(jid, { video: { url: media }, caption }, { quoted });
    } catch (_) { /* fall back to text when a remote host rejects streaming */ }
  }
  return sock.sendMessage(jid, { text: clip(data) }, { quoted });
}

module.exports = { parseIncoming, textOf, clip, collectUrls, pickMedia, sendApiResult };
