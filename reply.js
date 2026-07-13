'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const cache = new Map();
let githubIdentity = null;
let syncQueue = Promise.resolve();

function safeSessionId(value) {
  const id = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  if (!id) throw new Error('Invalid session ID.');
  return id;
}

function statePath(sessionId) {
  return path.join(config.SESSION_DIR, safeSessionId(sessionId), 'auto-replies.json');
}

function emptyState() {
  return { enabled: false, replies: {}, updatedAt: new Date().toISOString() };
}

function normalizeState(value) {
  return {
    enabled: Boolean(value?.enabled),
    replies: value?.replies && typeof value.replies === 'object' && !Array.isArray(value.replies) ? value.replies : {},
    updatedAt: value?.updatedAt || new Date().toISOString()
  };
}

function loadState(sessionId) {
  const id = safeSessionId(sessionId);
  if (cache.has(id)) return cache.get(id);
  let state = emptyState();
  const file = statePath(id);
  try { state = normalizeState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`Auto-reply read failed (${id}): ${error.message}`); }
  cache.set(id, state);
  return state;
}

function writeLocal(sessionId, state) {
  const file = statePath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': `${config.BOT_NAME}/1.0`
  };
}

async function githubRequest(url, options = {}, allowed = []) {
  const response = await fetch(url, { ...options, headers: { ...githubHeaders(), ...(options.headers || {}) } });
  if (response.ok || allowed.includes(response.status)) return response;
  const text = await response.text();
  throw new Error(`GitHub HTTP ${response.status}: ${text.slice(0, 300)}`);
}

async function ensureGithubRepo() {
  if (!config.GITHUB_TOKEN) return null;
  if (!githubIdentity) {
    const response = await githubRequest('https://api.github.com/user');
    githubIdentity = await response.json();
  }
  const owner = config.GITHUB_OWNER || githubIdentity.login;
  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(config.GITHUB_REPO)}`;
  const existing = await githubRequest(repoUrl, {}, [404]);
  if (existing.status !== 404) return { owner, repo: config.GITHUB_REPO };
  if (owner.toLowerCase() !== githubIdentity.login.toLowerCase()) {
    throw new Error(`Repository ${owner}/${config.GITHUB_REPO} does not exist and cannot be created under another owner.`);
  }
  await githubRequest('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: config.GITHUB_REPO,
      description: `${config.BOT_NAME} per-session auto replies`,
      private: config.GITHUB_PRIVATE_REPO,
      auto_init: true
    })
  });
  return { owner, repo: config.GITHUB_REPO };
}

async function pushToGithub(sessionId, state) {
  const target = await ensureGithubRepo();
  if (!target) return { synced: false, reason: 'GITHUB_TOKEN is not configured' };
  const repoPath = `replies/${safeSessionId(sessionId)}/auto-replies.json`;
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${repoPath}`;
  const current = await githubRequest(`${url}?ref=${encodeURIComponent(config.GITHUB_BRANCH)}`, {}, [404]);
  const currentData = current.status === 404 ? null : await current.json();
  const body = {
    message: `Update auto replies for ${safeSessionId(sessionId)}`,
    content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8').toString('base64'),
    branch: config.GITHUB_BRANCH
  };
  if (currentData?.sha) body.sha = currentData.sha;
  await githubRequest(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { synced: true, repository: `${target.owner}/${target.repo}`, path: repoPath };
}

async function initializeFromGithub(sessionId) {
  const id = safeSessionId(sessionId);
  const local = loadState(id);
  if (!config.GITHUB_TOKEN) return local;
  const target = await ensureGithubRepo();
  const repoPath = `replies/${id}/auto-replies.json`;
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${repoPath}?ref=${encodeURIComponent(config.GITHUB_BRANCH)}`;
  const response = await githubRequest(url, {}, [404]);
  if (response.status === 404) return local;
  const remote = await response.json();
  if (!remote.content) return local;
  const state = normalizeState(JSON.parse(Buffer.from(remote.content.replace(/\s/g, ''), 'base64').toString('utf8')));
  cache.set(id, state);
  writeLocal(id, state);
  return state;
}

function queueGithubSync(sessionId, state) {
  if (!config.GITHUB_TOKEN) return Promise.resolve({ synced: false, reason: 'GITHUB_TOKEN is not configured' });
  syncQueue = syncQueue.catch(() => {}).then(() => pushToGithub(sessionId, state));
  return syncQueue;
}

async function saveState(sessionId, state, waitForGithub = false) {
  const id = safeSessionId(sessionId);
  state.updatedAt = new Date().toISOString();
  cache.set(id, state);
  writeLocal(id, state);
  const sync = queueGithubSync(id, state);
  if (waitForGithub) return sync;
  sync.catch(error => console.warn(`GitHub reply sync failed (${id}): ${error.message}`));
  return { synced: false, queued: Boolean(config.GITHUB_TOKEN) };
}

async function setEnabled(sessionId, enabled) {
  const state = loadState(sessionId);
  state.enabled = Boolean(enabled);
  await saveState(sessionId, state);
  return state;
}

async function addReply(sessionId, trigger, response) {
  const key = String(trigger || '').trim().toLowerCase();
  const value = String(response || '').trim().replace(/\\n/g, '\n');
  if (!key || !value) throw new Error('Trigger and response are required.');
  if (key.length > 200 || value.length > 4000) throw new Error('Reply is too long.');
  const state = loadState(sessionId);
  state.replies[key] = value;
  await saveState(sessionId, state);
  return state;
}

async function deleteReply(sessionId, trigger) {
  const state = loadState(sessionId);
  const key = String(trigger || '').trim().toLowerCase();
  const existed = Object.prototype.hasOwnProperty.call(state.replies, key);
  if (existed) delete state.replies[key];
  await saveState(sessionId, state);
  return existed;
}

async function clearReplies(sessionId) {
  const state = loadState(sessionId);
  state.replies = {};
  await saveState(sessionId, state);
  return state;
}

function matchReply(sessionId, incomingText) {
  const state = loadState(sessionId);
  if (!state.enabled) return null;
  const key = String(incomingText || '').trim().toLowerCase();
  return state.replies[key] || state.replies['*'] || null;
}

async function forceGithubSync(sessionId) {
  return queueGithubSync(safeSessionId(sessionId), loadState(sessionId));
}

module.exports = {
  initializeFromGithub,
  loadState,
  setEnabled,
  addReply,
  deleteReply,
  clearReplies,
  matchReply,
  forceGithubSync
};
