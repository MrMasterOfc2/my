'use strict';

const path = require('path');

module.exports = Object.freeze({
  BOT_NAME: process.env.BOT_NAME || 'Sahan AI',
  PREFIX: process.env.PREFIX || '.',
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  OWNER_NUMBERS: (process.env.OWNER_NUMBERS || '').split(',').map(v => v.replace(/\D/g, '')).filter(Boolean),
  SESSION_DIR: path.resolve(process.env.SESSION_DIR || './sessions'),
  API_BASE: 'https://apis.davidcyril.name.ng',
  API_TIMEOUT_MS: Number(process.env.API_TIMEOUT_MS) || 60_000,
  MAX_DOWNLOAD_MB: Number(process.env.MAX_DOWNLOAD_MB) || 95,
  MAX_SESSIONS: Number(process.env.MAX_SESSIONS) || 20,
  AUTO_READ: process.env.AUTO_READ === 'true',
  PUBLIC_MODE: process.env.PUBLIC_MODE !== 'false',
  // Auto-reply GitHub backup. Keep the token in an environment variable only.
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_OWNER: process.env.GITHUB_OWNER || '',
  GITHUB_REPO: process.env.GITHUB_REPO || 'sahan-ai-replies',
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  GITHUB_PRIVATE_REPO: process.env.GITHUB_PRIVATE_REPO !== 'false',
  // Set false to hide the adult API category from generated commands.
  ENABLE_NSFW: process.env.ENABLE_NSFW === 'true',
  DOC_CATEGORIES: [
    'ai', 'aimusic', 'anime', 'canvas', 'download', 'fun', 'games',
    'imagegen', 'imageToImage', 'movies', 'news', 'random', 'search',
    'socialboost', 'sports', 'stalk', 'tempmail', 'tempnumber', 'tools',
    'uploader', 'urlshortener', 'xxx'
  ]
});
