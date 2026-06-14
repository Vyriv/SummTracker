const fs = require('fs');
const path = require('path');
const https = require('https');
const fetch = require('node-fetch');

const LOCKFILE_PATHS = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  path.join(process.env.LOCALAPPDATA || '', 'Riot Games\\League of Legends\\lockfile'),
];

const agent = new https.Agent({ rejectUnauthorized: false });

function parseLockfile(content) {
  const [name, pid, port, password, protocol] = content.split(':');
  return { port, password, protocol };
}

function findLockfile() {
  for (const p of LOCKFILE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readLockfile() {
  const lockPath = findLockfile();
  if (!lockPath) return null;
  try {
    return parseLockfile(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function lcuFetch(endpoint) {
  const lock = readLockfile();
  if (!lock) throw new Error('League client not running');

  const auth = Buffer.from(`riot:${lock.password}`).toString('base64');
  const url = `https://127.0.0.1:${lock.port}${endpoint}`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    agent,
  });

  if (!res.ok) throw new Error(`LCU ${res.status}: ${endpoint}`);
  return res.json();
}

async function getChampSelectSession() {
  try {
    return await lcuFetch('/lol-champ-select/v1/session');
  } catch {
    return null;
  }
}

async function getSummonerByPuuid(puuid) {
  return lcuFetch(`/lol-summoners/v2/summoners/puuid/${puuid}`);
}

function isClientRunning() {
  return !!readLockfile();
}

module.exports = { lcuFetch, getChampSelectSession, isClientRunning };
