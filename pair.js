'use strict';

const config = require('./config');
const { clip, sendApiResult } = require('./msg');
const autoReplies = require('./reply');

let catalog = [];
let loadedAt = 0;

// ============================================================================
// 01. AI COMMANDS
// Add or remove AI shortcut commands only inside this section.
// ============================================================================
const AI_COMMANDS = {
  // .ai <question> - DeepSeek V3 chat
  ai: { path: '/ai/deepseek-v3', param: 'text' },

  // .gpt <question> - ChatGPT response
  gpt: { path: '/ai/chatgpt', param: 'text' },

  // .gemini <question> - Google Gemini response
  gemini: { path: '/ai/gemini', param: 'text' }
};

// ============================================================================
// 02. SEARCH COMMANDS
// ============================================================================
const SEARCH_COMMANDS = {
  // .google <query> - Google web search
  google: { path: '/search/google', param: 'q' },

  // .yts <query> - YouTube search
  yts: { path: '/youtube/search', param: 'q' },

  // .spotify <query> - Spotify music search
  spotify: { path: '/search/spotify', param: 'text' },

  // .pinterest <query> - Pinterest image search
  pinterest: { path: '/search/pinterest', param: 'text' },

  // .wallpaper <query> - Wallpaper search
  wallpaper: { path: '/search/wallpaper', param: 'text' },

  // .lyrics <song> - Song lyrics search
  lyrics: { path: '/lyrics/search', param: 'q' }
};

// ============================================================================
// 03. DOWNLOAD COMMANDS
// ============================================================================
const DOWNLOAD_COMMANDS = {
  // .play <youtube-url> - Download YouTube audio
  play: { path: '/download/ytmp3', param: 'url' },

  // .song <name> - Search and download a song
  song: { path: '/song', param: 'query' },

  // .video <youtube-url> - Download YouTube video
  video: { path: '/download/ytmp4', param: 'url' },

  // .tiktok <url> - Download TikTok video
  tiktok: { path: '/download/tiktok', param: 'url' },

  // .facebook <url> - Download Facebook video
  facebook: { path: '/facebook', param: 'url' },

  // .instagram <url> - Download Instagram media
  instagram: { path: '/instagram', param: 'url' },

  // .twitter <url> - Download Twitter/X video
  twitter: { path: '/twitter', param: 'url' }
};

// ============================================================================
// 04. FUN COMMANDS
// ============================================================================
const FUN_COMMANDS = {
  // .fact - Send a random fact
  fact: { path: '/fact' },

  // .truth - Send a truth question
  truth: { path: '/truth' },

  // .dare - Send a random dare
  dare: { path: '/dare' },

  // .pickup - Send a pickup line
  pickup: { path: '/pickupline' }
};

// All shortcut categories are combined here for the shared API executor.
const SHORTCUT_COMMANDS = {
  ...AI_COMMANDS,
  ...SEARCH_COMMANDS,
  ...DOWNLOAD_COMMANDS,
  ...FUN_COMMANDS
};

// ============================================================================
// 05. DAVID CYRIL API DOCUMENTATION PARSER
// Loads newly-added API endpoints automatically from the official docs.
// ============================================================================

function extractJsonArray(html) {
  const marker = 'let endpointsData =';
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return [];
  const start = html.indexOf('[', markerAt);
  let depth = 0, quoted = '', escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quoted) quoted = '';
      continue;
    }
    if (char === '"' || char === "'") quoted = char;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return JSON.parse(normalizeJsLiteral(html.slice(start, i + 1)));
  }
  return [];
}

// The documentation embeds mostly-JSON arrays, with occasional JS comments and
// single-quoted method arrays. Convert only literal syntax; never execute it.
function normalizeJsLiteral(source) {
  let output = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (char === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      output += '\n';
      continue;
    }
    if (char === '"') {
      const begin = i++;
      let escaped = false;
      while (i < source.length) {
        if (!escaped && source[i] === '"') break;
        escaped = !escaped && source[i] === '\\';
        if (source[i] !== '\\') escaped = false;
        i++;
      }
      output += source.slice(begin, i + 1);
      continue;
    }
    if (char === "'") {
      let value = '';
      for (i++; i < source.length; i++) {
        if (source[i] === "'") break;
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[++i];
          value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escaped] ?? escaped;
        } else value += source[i];
      }
      output += JSON.stringify(value);
      continue;
    }
    output += char;
  }
  return output.replace(/\bundefined\b/g, 'null').replace(/,\s*([}\]])/g, '$1');
}

function slug(alias) {
  return alias.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30);
}

// ============================================================================
// 06. NETWORK AND API HELPERS
// ============================================================================
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.API_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function loadCatalog(force = false) {
  if (!force && catalog.length && Date.now() - loadedAt < 3_600_000) return catalog;
  const categories = config.DOC_CATEGORIES.filter(c => config.ENABLE_NSFW || c !== 'xxx');
  const results = await Promise.allSettled(categories.map(async category => {
    const response = await fetchWithTimeout(`${config.API_BASE}/endpoints/${category}/`);
    if (!response.ok) throw new Error(`${category}: HTTP ${response.status}`);
    return extractJsonArray(await response.text()).map(item => ({ ...item, docCategory: category }));
  }));
  const failures = results.map((result, index) => result.status === 'rejected' ? `${categories[index]}: ${result.reason?.message || result.reason}` : null).filter(Boolean);
  if (failures.length && process.env.LOG_LEVEL === 'debug') console.warn(`API catalog partial load:\n${failures.join('\n')}`);
  const fresh = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  if (fresh.length) { catalog = fresh; loadedAt = Date.now(); }
  return catalog;
}

function findEndpoint(command) {
  const key = command.toLowerCase();
  return catalog.find(item => slug(item.alias) === key || item.path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '').toLowerCase() === key);
}

function parseParams(endpoint, query) {
  const required = endpoint.parameters?.required || [];
  const optional = endpoint.parameters?.optional || [];
  const known = [...required, ...optional];
  const params = {};
  const keyed = [...query.matchAll(/(?:^|\s)([\w-]+)=("[^"]*"|'[^']*'|\S+)/g)];
  for (const match of keyed) params[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  if (!keyed.length && required.length === 1) params[required[0].name] = query;
  if (!keyed.length && required.length > 1) {
    query.split('|').map(v => v.trim()).forEach((value, i) => { if (required[i]) params[required[i].name] = value; });
  }
  const missing = required.filter(p => !params[p.name]).map(p => p.name);
  return { params, missing, known };
}

async function callApi(endpoint, params) {
  const method = (endpoint.method || endpoint.methods?.[0] || 'GET').toUpperCase();
  let url = `${config.API_BASE}${endpoint.path}`;
  const options = { method, headers: { Accept: 'application/json', 'User-Agent': `${config.BOT_NAME}/1.0` } };
  if (method === 'GET') url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;
  else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(params);
  }
  const response = await fetchWithTimeout(url, options);
  const type = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${clip(await response.text(), 300)}`);
  if (type.includes('application/json')) return { data: await response.json(), endpoint: endpoint.path };
  return { data: { success: true, result: url, contentType: type }, endpoint: endpoint.path };
}

// ============================================================================
// 07. BOT MENU
// Update this section when a new manual shortcut is added.
// ============================================================================
function menu(prefix, count) {
  return `╭━━━〔 *${config.BOT_NAME}* 〕━━━⊷\n` +
    `┃ Prefix: ${prefix}\n┃ Dynamic APIs: ${count}\n┃ Mode: ${config.PUBLIC_MODE ? 'Public' : 'Private'}\n` +
    `╰━━━━━━━━━━━━━━━━⊷\n\n` +
    `*CORE*\n${prefix}menu  ${prefix}ping  ${prefix}alive  ${prefix}owner\n\n` +
    `*AUTO REPLY*\n${prefix}autoreply on|off|status\n${prefix}addreply trigger | response\n${prefix}delreply trigger\n${prefix}replies\n${prefix}clearreplies\n${prefix}githubsync\n\n` +
    `*AI & SEARCH*\n${prefix}ai question\n${prefix}gpt question\n${prefix}gemini question\n${prefix}google query\n${prefix}yts query\n${prefix}lyrics song\n${prefix}pinterest query\n${prefix}wallpaper query\n\n` +
    `*DOWNLOAD*\n${prefix}play youtube-url\n${prefix}video youtube-url\n${prefix}tiktok url\n${prefix}facebook url\n${prefix}instagram url\n${prefix}twitter url\n\n` +
    `*FUN*\n${prefix}fact  ${prefix}truth  ${prefix}dare  ${prefix}pickup\n\n` +
    `*ALL DAVID APIs*\n${prefix}apis [category/page]\n${prefix}api /path key=value\n${prefix}<generated-command> value\n\n_Powered by David Cyril APIs_`;
}

// ============================================================================
// 08. COMMAND HANDLER
// Core commands have separate cases below. Shortcut commands are organized in
// the AI, Search, Download and Fun sections at the top of this file.
// ============================================================================
async function handleCommand(sock, message, sessionId) {
  const { command, query, chat, raw, sender } = message;
  const reply = text => sock.sendMessage(chat, { text }, { quoted: raw });
  const senderNumber = sender.split('@')[0].split(':')[0].replace(/\D/g, '');
  const sessionNumber = String(sock.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const isSessionOwner = message.fromMe || senderNumber === sessionNumber || config.OWNER_NUMBERS.includes(senderNumber);
  if (!command) return false;
  await loadCatalog().catch(() => catalog);

  switch (command) {
    // ------------------------------------------------------------------------
    // CORE COMMAND: .menu
    // ------------------------------------------------------------------------
    case 'menu':
      await reply(menu(config.PREFIX, catalog.length));
      return true;

    // ------------------------------------------------------------------------
    // CORE COMMAND: .help
    // ------------------------------------------------------------------------
    case 'help':
      await reply(menu(config.PREFIX, catalog.length));
      return true;

    // ------------------------------------------------------------------------
    // CORE COMMAND: .commands
    // ------------------------------------------------------------------------
    case 'commands':
      await reply(menu(config.PREFIX, catalog.length));
      return true;

    // ------------------------------------------------------------------------
    // CORE COMMAND: .ping
    // ------------------------------------------------------------------------
    case 'ping': {
      const start = Date.now();
      await reply(`🏓 Pong! ${Date.now() - start}ms\nSession: ${sessionId}`);
      return true;
    }

    // ------------------------------------------------------------------------
    // CORE COMMAND: .alive
    // ------------------------------------------------------------------------
    case 'alive':
      await reply(`✅ *${config.BOT_NAME}* is online.\nMulti-device session: ${sessionId}`);
      return true;

    // ------------------------------------------------------------------------
    // CORE COMMAND: .owner
    // ------------------------------------------------------------------------
    case 'owner':
      await reply(
        config.OWNER_NUMBERS.length
          ? config.OWNER_NUMBERS.map(number => `wa.me/${number}`).join('\n')
          : 'Owner number is not configured.'
      );
      return true;

    // ------------------------------------------------------------------------
    // OWNER COMMAND: .reloadapis
    // ------------------------------------------------------------------------
    case 'reloadapis': {
      if (!isSessionOwner) {
        await reply('Owner-only command.');
        return true;
      }
      await loadCatalog(true);
      await reply(`Reloaded ${catalog.length} API endpoints.`);
      return true;
    }

    // ------------------------------------------------------------------------
    // AUTO-REPLY COMMAND: .autoreply on|off|status
    // ------------------------------------------------------------------------
    case 'autoreply': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      const action = query.trim().toLowerCase();
      if (action === 'on') {
        const state = await autoReplies.setEnabled(sessionId, true);
        await reply(`Auto reply is ON.\nSaved replies: ${Object.keys(state.replies).length}`);
      } else if (action === 'off') {
        const state = await autoReplies.setEnabled(sessionId, false);
        await reply(`Auto reply is OFF.\nSaved replies: ${Object.keys(state.replies).length}`);
      } else if (!action || action === 'status') {
        const state = autoReplies.loadState(sessionId);
        await reply(`Auto reply: ${state.enabled ? 'ON' : 'OFF'}\nSaved replies: ${Object.keys(state.replies).length}`);
      } else {
        await reply(`Usage: ${config.PREFIX}autoreply on|off|status`);
      }
      return true;
    }

    // ------------------------------------------------------------------------
    // AUTO-REPLY COMMAND: .addreply trigger | response
    // Use * as the trigger to create a fallback reply.
    // ------------------------------------------------------------------------
    case 'addreply': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      const separator = query.indexOf('|');
      if (separator < 1) {
        await reply(`Usage: ${config.PREFIX}addreply hello | Hello! How can I help?`);
        return true;
      }
      const trigger = query.slice(0, separator).trim();
      const response = query.slice(separator + 1).trim();
      try {
        const state = await autoReplies.addReply(sessionId, trigger, response);
        await reply(`Reply saved for: ${trigger}\nTotal replies: ${Object.keys(state.replies).length}`);
      } catch (error) {
        await reply(`Could not save reply: ${error.message}`);
      }
      return true;
    }

    // ------------------------------------------------------------------------
    // AUTO-REPLY COMMAND: .delreply trigger
    // ------------------------------------------------------------------------
    case 'delreply': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      if (!query.trim()) { await reply(`Usage: ${config.PREFIX}delreply trigger`); return true; }
      const deleted = await autoReplies.deleteReply(sessionId, query);
      await reply(deleted ? `Reply deleted: ${query.trim()}` : `Reply not found: ${query.trim()}`);
      return true;
    }

    // ------------------------------------------------------------------------
    // AUTO-REPLY COMMAND: .replies
    // ------------------------------------------------------------------------
    case 'replies': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      const state = autoReplies.loadState(sessionId);
      const entries = Object.entries(state.replies);
      const list = entries.slice(0, 100).map(([trigger, response], index) =>
        `${index + 1}. *${trigger}* → ${clip(response, 120)}`
      ).join('\n\n');
      await reply(`*Auto Replies (${entries.length})*\nStatus: ${state.enabled ? 'ON' : 'OFF'}\n\n${list || 'No replies saved.'}`);
      return true;
    }

    // ------------------------------------------------------------------------
    // AUTO-REPLY COMMAND: .clearreplies
    // ------------------------------------------------------------------------
    case 'clearreplies': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      if (query.trim().toLowerCase() !== 'confirm') {
        await reply(`This deletes every saved reply. Use: ${config.PREFIX}clearreplies confirm`);
        return true;
      }
      await autoReplies.clearReplies(sessionId);
      await reply('All auto replies were deleted.');
      return true;
    }

    // ------------------------------------------------------------------------
    // GITHUB COMMAND: .githubsync
    // ------------------------------------------------------------------------
    case 'githubsync': {
      if (!isSessionOwner) { await reply('Owner-only command.'); return true; }
      try {
        const result = await autoReplies.forceGithubSync(sessionId);
        await reply(result.synced
          ? `GitHub sync complete.\nRepo: ${result.repository}\nPath: ${result.path}`
          : `GitHub sync disabled: ${result.reason}`);
      } catch (error) {
        await reply(`GitHub sync failed: ${error.message}`);
      }
      return true;
    }

    // ------------------------------------------------------------------------
    // API CATALOG COMMAND: .apis [category or page]
    // ------------------------------------------------------------------------
    case 'apis': {
      const isPage = /^\d+$/.test(query);
      const term = isPage ? '' : query.toLowerCase();
      const page = isPage ? Math.max(1, Number(query)) : 1;
      const filtered = catalog.filter(endpoint =>
        !term ||
        endpoint.category?.toLowerCase().includes(term) ||
        endpoint.docCategory?.toLowerCase().includes(term)
      );
      const items = filtered.slice((page - 1) * 35, page * 35);
      const list = items.map(endpoint =>
        `${config.PREFIX}${slug(endpoint.alias)} — ${endpoint.alias}`
      ).join('\n') || 'No endpoints found.';

      await reply(
        `*${config.BOT_NAME} API Catalog* (${filtered.length})\n\n${list}\n\n` +
        `Use: ${config.PREFIX}apis category  or  ${config.PREFIX}apis ${page + 1}`
      );
      return true;
    }

    default:
      // Shortcut and auto-generated commands continue below.
      break;
  }

  // --------------------------------------------------------------------------
  // DIRECT API COMMAND: .api /path key=value
  // --------------------------------------------------------------------------
  let endpoint;
  let params;
  if (command === 'api') {
    const [path, ...rest] = query.split(/\s+/);
    endpoint = catalog.find(e => e.path === path);
    if (!endpoint) { await reply(`Unknown API path. Use ${config.PREFIX}apis first.`); return true; }
    ({ params } = parseParams(endpoint, rest.join(' ')));
  // --------------------------------------------------------------------------
  // SHORTCUT COMMAND: Uses categorized definitions at the top of this file.
  // --------------------------------------------------------------------------
  } else if (SHORTCUT_COMMANDS[command]) {
    const item = SHORTCUT_COMMANDS[command];
    const documented = catalog.find(e => e.path === item.path);
    endpoint = documented || { path: item.path, method: 'GET', parameters: { required: item.param ? [{ name: item.param }] : [] } };
    params = documented ? parseParams(documented, query).params : (item.param ? { [item.param]: query } : {});
  // --------------------------------------------------------------------------
  // AUTO COMMAND: Generated from all available David Cyril API endpoints.
  // --------------------------------------------------------------------------
  } else {
    endpoint = findEndpoint(command);
    if (!endpoint) return false;
    const parsed = parseParams(endpoint, query);
    params = parsed.params;
    if (parsed.missing.length) {
      await reply(`Missing: ${parsed.missing.join(', ')}\nUse: ${config.PREFIX}${command} ${parsed.known.map(p => `${p.name}=value`).join(' ')}`);
      return true;
    }
  }

  const required = endpoint.parameters?.required || [];
  if (required.length && required.some(p => !params[p.name])) {
    await reply(`Usage: ${config.PREFIX}${command} ${required.map(p => `${p.name}=value`).join(' ')}`); return true;
  }
  await reply('⏳ Processing...');
  try {
    const result = await callApi(endpoint, params);
    await sendApiResult(sock, chat, raw, result.data, result.endpoint);
  } catch (error) {
    await reply(`❌ API request failed.\n${error.name === 'AbortError' ? 'Request timed out.' : clip(error.message, 500)}`);
  }
  return true;
}

module.exports = { handleCommand, loadCatalog, slug, callApi };
