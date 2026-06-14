const https = require('https');
const fetch = require('node-fetch');

const agent = new https.Agent({ rejectUnauthorized: false });
const BASE = 'https://127.0.0.1:2999/liveclientdata';

async function liveGet(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, { agent });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Live API ${res.status} ${endpoint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getAllPlayers() {
  return liveGet('/playerlist');
}

async function getAllGameData() {
  return liveGet('/allgamedata');
}

async function getGameStats() {
  return liveGet('/gamestats');
}

async function getActivePlayer() {
  return liveGet('/activeplayer');
}

async function isGameRunning() {
  try {
    await liveGet('/gamestats');
    return true;
  } catch {
    return false;
  }
}

module.exports = { getAllPlayers, getAllGameData, getGameStats, getActivePlayer, isGameRunning };
