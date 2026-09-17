import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  getSummonerSpell,
  getUltCooldowns,
  getUltLevelFromChampLevel,
  applyUltItemHaste,
  applySummonerSpellHaste,
  initItemHaste,
} from './cooldowns.js';

// ── Settings ──

const DEFAULT_SETTINGS = {
  showOwnTeam: true,
  showChampName: true,
  showSummonerName: true,
  format: 'mm:ss',
  opacity: 90,
  collapseBind: null,
  autoAcceptQueue: false,
  preferList: [],
};

let settings = { ...DEFAULT_SETTINGS };

let ownTeam = null;
let localPlayerId = null;
let enemyPlayerIndices = [];
let pendingSyncEvents = [];
let syncPeerIds = new Set();

function saveSettings() {
  invoke('save_settings', { settings });
}

function applySettings() {
  document.body.classList.toggle('hide-champ-name', !settings.showChampName);
  document.body.classList.toggle('hide-summoner-name', !settings.showSummonerName);
  document.body.classList.toggle('hide-own-team', !settings.showOwnTeam);

  document.getElementById('s-own-team').checked = settings.showOwnTeam;
  document.getElementById('s-champ-name').checked = settings.showChampName;
  document.getElementById('s-summoner-name').checked = settings.showSummonerName;
  document.getElementById('s-auto-accept').checked = settings.autoAcceptQueue;
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fmt === settings.format);
  });

  const opacity = settings.opacity ?? 90;
  const app = document.getElementById('app');
  const bgAlpha = (opacity / 100).toFixed(2);
  app.style.setProperty('--bg-opacity', bgAlpha);
  const shadowStrength = Math.max(0, 1 - opacity / 60);
  const shadow = shadowStrength > 0
    ? `0 1px ${Math.round(shadowStrength * 6)}px #000, 0 0 ${Math.round(shadowStrength * 10)}px #000`
    : 'none';
  document.body.style.setProperty('--text-shadow', shadow);

  const opacitySlider = document.getElementById('s-opacity');
  if (opacitySlider) {
    opacitySlider.value = opacity;
    document.getElementById('s-opacity-value').textContent = `${opacity}%`;
  }

  const bindBtn = document.getElementById('s-collapse-bind');
  if (bindBtn && !bindBtn.classList.contains('listening')) {
    const b = settings.collapseBind;
    if (!b) {
      bindBtn.textContent = 'None';
    } else {
      const parts = [];
      if (b.ctrl)  parts.push('Ctrl');
      if (b.alt)   parts.push('Alt');
      if (b.shift) parts.push('Shift');
      parts.push(b.key.toUpperCase());
      bindBtn.textContent = parts.join('+');
    }
  }
}

function initSettingsPanel() {
  document.getElementById('s-own-team').addEventListener('change', e => {
    settings.showOwnTeam = e.target.checked;
    saveSettings();
    applySettings();
  });

  document.getElementById('s-champ-name').addEventListener('change', e => {
    settings.showChampName = e.target.checked;
    saveSettings();
    applySettings();
  });

  document.getElementById('s-summoner-name').addEventListener('change', e => {
    settings.showSummonerName = e.target.checked;
    saveSettings();
    applySettings();
  });

  document.getElementById('s-auto-accept').addEventListener('change', e => {
    settings.autoAcceptQueue = e.target.checked;
    saveSettings();
  });

  const preferBtn = document.getElementById('s-prefer-list');
  if (preferBtn) {
    preferBtn.addEventListener('click', () => {
      setPreferOpen(true);
    });
  }

  const preferBack = document.getElementById('prefer-back');
  if (preferBack) {
    preferBack.addEventListener('click', () => {
      setPreferOpen(false);
      settingsOpen = true;
      document.getElementById('settings-btn').classList.add('active');
      document.getElementById('settings-panel').classList.remove('hidden');
      document.getElementById('prefer-panel').classList.add('hidden');
      document.getElementById('game-screen').classList.add('hidden');
      document.getElementById('idle-screen').classList.add('hidden');
      document.getElementById('champ-select-screen').classList.add('hidden');
      invoke('set_focusable', { focusable: true, stealFocus: false });
      syncGameHeight(true);
    });
  }

  const preferSearch = document.getElementById('prefer-search');
  if (preferSearch) {
    preferSearch.addEventListener('input', e => renderPreferSuggestions(e.target.value));
    preferSearch.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = document.querySelector('#prefer-suggestions .prefer-suggest');
      if (first) first.click();
    });
  }

  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.format = btn.dataset.fmt;
      saveSettings();
      applySettings();
    });
  });

  document.getElementById('s-opacity').addEventListener('input', e => {
    settings.opacity = Number(e.target.value);
    saveSettings();
    applySettings();
  });

  const autostartToggle = document.getElementById('s-autostart');
  if (autostartToggle) {
    invoke('get_autostart').then(enabled => {
      autostartToggle.checked = Boolean(enabled);
    }).catch(() => {});
    autostartToggle.addEventListener('change', e => {
      invoke('set_autostart', { enabled: e.target.checked }).catch(() => {
        e.target.checked = !e.target.checked;
      });
    });
  }

  const bindBtn = document.getElementById('s-collapse-bind');
  let listeningForBind = false;

  bindBtn.addEventListener('click', () => {
    if (listeningForBind) return;
    listeningForBind = true;
    bindBtn.textContent = '…';
    bindBtn.classList.add('listening');
  });

  window.addEventListener('keydown', (e) => {
    if (listeningForBind) {
      e.preventDefault();
      const key = e.key.toLowerCase();
      const isModifierOnly = key === 'shift' || key === 'control' || key === 'ctrl' || key === 'alt' || key === 'meta';
      if (isModifierOnly) {
        return;
      }
      if (e.key === 'Escape') {
        settings.collapseBind = null;
      } else {
        settings.collapseBind = {
          key,
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
        };
      }
      listeningForBind = false;
      bindBtn.classList.remove('listening');
      saveSettings();
      applySettings();
      invoke('update_collapse_bind', { bind: settings.collapseBind });
      return;
    }
  }, true);
}

let settingsOpen = false;
let preferOpen = false;
let preferChampions = [];

function champSelectIconUrlPrefer(id) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;
}

function normalizePreferList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const id = Number(entry?.id ?? entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = entry?.name || preferChampions.find(c => c.key === id)?.name || champById[id]?.name || `Champ ${id}`;
    out.push({ id, name });
  }
  return out;
}

function savePreferList() {
  settings.preferList = normalizePreferList(settings.preferList);
  saveSettings();
}

function renderPreferList() {
  const listEl = document.getElementById('prefer-list');
  const emptyEl = document.getElementById('prefer-empty');
  if (!listEl || !emptyEl) return;
  const list = Array.isArray(settings.preferList) ? settings.preferList : [];
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', list.length > 0);

  list.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'prefer-row';

    const rank = document.createElement('div');
    rank.className = 'prefer-rank';
    rank.textContent = String(index + 1);
    row.appendChild(rank);

    const img = document.createElement('img');
    img.src = champSelectIconUrlPrefer(entry.id);
    img.alt = entry.name;
    img.onerror = () => { img.style.background = '#222'; };
    row.appendChild(img);

    const name = document.createElement('div');
    name.className = 'prefer-name';
    name.textContent = entry.name;
    row.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'prefer-actions';

    const up = document.createElement('button');
    up.type = 'button';
    up.title = 'Move up';
    up.textContent = '▲';
    up.disabled = index === 0;
    up.addEventListener('click', () => movePreferEntry(index, -1));

    const down = document.createElement('button');
    down.type = 'button';
    down.title = 'Move down';
    down.textContent = '▼';
    down.disabled = index === list.length - 1;
    down.addEventListener('click', () => movePreferEntry(index, 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'prefer-remove';
    remove.title = 'Remove';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      settings.preferList = settings.preferList.filter((_, i) => i !== index);
      savePreferList();
      renderPreferList();
      renderPreferSuggestions(document.getElementById('prefer-search')?.value || '');
    });

    actions.append(up, down, remove);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
  if (preferOpen) syncGameHeight(true);
}

function movePreferEntry(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= settings.preferList.length) return;
  const list = settings.preferList.slice();
  const [item] = list.splice(index, 1);
  list.splice(next, 0, item);
  settings.preferList = list;
  savePreferList();
  renderPreferList();
}

function addPreferChampion(champ) {
  if (!champ?.key) return;
  if (settings.preferList.some(e => e.id === champ.key)) return;
  settings.preferList = [...settings.preferList, { id: champ.key, name: champ.name }];
  savePreferList();
  renderPreferList();
  const search = document.getElementById('prefer-search');
  if (search) {
    search.value = '';
    renderPreferSuggestions('');
    search.focus();
  }
}

function renderPreferSuggestions(query) {
  const box = document.getElementById('prefer-suggestions');
  if (!box) return;
  box.innerHTML = '';
  const q = String(query || '').trim().toLowerCase();
  if (!q) return;

  const selected = new Set(settings.preferList.map(e => e.id));
  const matches = preferChampions
    .filter(c => !selected.has(c.key) && c.name.toLowerCase().includes(q))
    .slice(0, 10);

  matches.forEach(champ => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prefer-suggest';
    const img = document.createElement('img');
    img.src = champSelectIconUrlPrefer(champ.key);
    img.alt = champ.name;
    const label = document.createElement('span');
    label.textContent = champ.name;
    btn.append(img, label);
    btn.addEventListener('click', () => addPreferChampion(champ));
    box.appendChild(btn);
  });
  if (preferOpen) syncGameHeight(true);
}

async function ensurePreferChampionsLoaded() {
  if (preferChampions.length) return;
  // Reuse already-fetched champById when available.
  const fromCache = Object.entries(champById).map(([key, champ]) => ({
    key: Number(key),
    name: champ.name,
    id: champ.id,
  }));
  if (fromCache.length) {
    preferChampions = fromCache.sort((a, b) => a.name.localeCompare(b.name));
    return;
  }
  try {
    const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json());
    const data = await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`).then(r => r.json());
    preferChampions = Object.values(data.data || {})
      .map(champ => ({ key: Number(champ.key), name: champ.name, id: champ.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {
    preferChampions = [];
  }
}

function setPreferOpen(open) {
  preferOpen = open;
  document.getElementById('prefer-panel').classList.toggle('hidden', !open);
  if (open) {
    settingsOpen = true;
    document.getElementById('settings-btn').classList.add('active');
    document.getElementById('settings-panel').classList.add('hidden');
    document.getElementById('game-screen').classList.add('hidden');
    document.getElementById('idle-screen').classList.add('hidden');
    document.getElementById('champ-select-screen').classList.add('hidden');
    ensurePreferChampionsLoaded().then(() => {
      settings.preferList = normalizePreferList(settings.preferList);
      renderPreferList();
      renderPreferSuggestions(document.getElementById('prefer-search')?.value || '');
    });
    invoke('set_focusable', { focusable: true, stealFocus: true });
  }
  syncGameHeight(true);
}

function toggleSettings() {
  if (preferOpen) {
    setPreferOpen(false);
  }
  settingsOpen = !settingsOpen;
  document.getElementById('settings-btn').classList.toggle('active', settingsOpen);
  document.getElementById('settings-panel').classList.toggle('hidden', !settingsOpen);
  document.getElementById('prefer-panel').classList.add('hidden');
  preferOpen = false;
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'game-screen');
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'idle-screen');
  document.getElementById('champ-select-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'champ-select-screen');

  invoke('set_focusable', {
    focusable: settingsOpen || currentScreen === 'champ-select-screen',
    stealFocus: settingsOpen,
  });
  syncGameHeight();
}

let currentScreen = 'idle-screen';

// ── Scaling ──

function updateScale() {
  const scale = document.body.clientWidth / 320;
  document.getElementById('app').style.transform = `scale(${scale})`;
}

let lastSyncedHeight = 0;
let syncHeightTimer = null;

function syncGameHeight(force = false) {
  if (syncHeightTimer != null) {
    clearTimeout(syncHeightTimer);
  }
  syncHeightTimer = setTimeout(() => {
    syncHeightTimer = null;
    requestAnimationFrame(() => {
      const app = document.getElementById('app');
      const h = app.scrollHeight;
      if (h <= 0) return;
      if (!force && Math.abs(h - lastSyncedHeight) < 1) return;
      lastSyncedHeight = h;
      invoke('set_natural_height', { height: h });
    });
  }, force ? 0 : 80);
}

new ResizeObserver(updateScale).observe(document.body);

let DDragon = 'https://ddragon.leagueoflegends.com/cdn/14.24.1';
const champById = {};

fetch('https://ddragon.leagueoflegends.com/api/versions.json')
  .then(r => r.json())
  .then(async versions => {
    DDragon = `https://ddragon.leagueoflegends.com/cdn/${versions[0]}`;
    const data = await fetch(`${DDragon}/data/en_US/champion.json`).then(r => r.json());
    Object.values(data.data || {}).forEach(champ => {
      champById[Number(champ.key)] = { id: champ.id, name: champ.name };
    });
  })
  .catch(() => {});

// ── Room cooldown sync + presence (api.vyriv.dev WebSocket relay) ──

const SUMMTRACKER_WS_BASE = 'wss://api.vyriv.dev/v1/summtracker/room';
const SYNC_RECONNECT_MIN_MS = 1000;
const SYNC_RECONNECT_MAX_MS = 15000;

function createRoomSocket(kind) {
  return {
    kind,
    roomId: null,
    socket: null,
    socketRoomId: null,
    connecting: false,
    reconnectTimer: null,
    reconnectDelayMs: SYNC_RECONNECT_MIN_MS,
    outgoingQueue: [],
    generation: 0,
  };
}

const cooldownLink = createRoomSocket('cooldown');
const presenceLink = createRoomSocket('presence');

function clearLinkReconnectTimer(link) {
  if (link.reconnectTimer != null) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
}

function closeRoomSocket(link) {
  clearLinkReconnectTimer(link);
  link.connecting = false;
  const socket = link.socket;
  link.socket = null;
  link.socketRoomId = null;
  if (!socket) return;
  try {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  } catch (_) {
    // ignore
  }
}

function flushLinkOutgoingQueue(link) {
  if (!link.socket || link.socket.readyState !== WebSocket.OPEN) return;
  if (!link.outgoingQueue.length) return;
  const queued = link.outgoingQueue.slice();
  link.outgoingQueue = [];
  for (const payload of queued) {
    try {
      link.socket.send(JSON.stringify(payload));
    } catch (_) {
      link.outgoingQueue.push(payload);
      break;
    }
  }
}

function enqueueLinkMessage(link, payload) {
  if (
    link.socket
    && link.socket.readyState === WebSocket.OPEN
    && link.socketRoomId === link.roomId
  ) {
    try {
      link.socket.send(JSON.stringify(payload));
      return;
    } catch (_) {
      // fall through to queue
    }
  }

  link.outgoingQueue.push(payload);
  if (link.outgoingQueue.length > 64) {
    link.outgoingQueue = link.outgoingQueue.slice(-64);
  }
}

function scheduleLinkReconnect(link, roomId, generation) {
  clearLinkReconnectTimer(link);
  if (link.roomId !== roomId) return;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (link.roomId !== roomId || generation !== link.generation) return;
    connectRoomSocket(link, roomId, generation);
  }, link.reconnectDelayMs);
  link.reconnectDelayMs = Math.min(
    SYNC_RECONNECT_MAX_MS,
    Math.round(link.reconnectDelayMs * 1.7),
  );
}

function handlePresencePayload(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.action === 'peers' && Array.isArray(payload.playerIds)) {
    syncPeerIds = new Set(
      payload.playerIds
        .filter((id) => typeof id === 'string' && id && id !== localPlayerId)
        .map((id) => id.toLowerCase()),
    );
    applyPeerBorders();
    return;
  }

  if (payload.action === 'peer-join' && typeof payload.playerId === 'string') {
    const id = payload.playerId.toLowerCase();
    if (!id || id === localPlayerId) return;
    syncPeerIds.add(id);
    applyPeerBorders();
    return;
  }

  if (payload.action === 'peer-leave' && typeof payload.playerId === 'string') {
    syncPeerIds.delete(payload.playerId.toLowerCase());
    applyPeerBorders();
  }
}

function sendPresenceHello(link) {
  if (!localPlayerId || !link.roomId) return;
  enqueueLinkMessage(link, { action: 'hello', playerId: localPlayerId });
}

function connectRoomSocket(link, roomId, generation) {
  if (!roomId || link.roomId !== roomId || generation !== link.generation) return;
  if (link.socket || link.connecting) return;

  link.connecting = true;
  let socket;
  try {
    socket = new WebSocket(`${SUMMTRACKER_WS_BASE}/${roomId}`);
  } catch (_) {
    link.connecting = false;
    scheduleLinkReconnect(link, roomId, generation);
    return;
  }

  link.socket = socket;
  link.socketRoomId = roomId;

  socket.onopen = () => {
    if (generation !== link.generation || link.roomId !== roomId || link.socket !== socket) {
      try { socket.close(); } catch (_) {}
      return;
    }
    link.connecting = false;
    link.reconnectDelayMs = SYNC_RECONNECT_MIN_MS;
    flushLinkOutgoingQueue(link);
    if (link.kind === 'presence') {
      sendPresenceHello(link);
    } else if (!presenceLink.roomId && localPlayerId && link.roomId) {
      // Presence is riding the cooldown socket for this match.
      sendPresenceHello(link);
    }
  };

  socket.onmessage = (event) => {
    if (generation !== link.generation || link.roomId !== roomId || link.socket !== socket) {
      return;
    }
    let payload;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : null;
    } catch (_) {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (link.kind === 'presence') {
      handlePresencePayload(payload);
      return;
    }

    if (payload.action === 'peers' || payload.action === 'peer-join' || payload.action === 'peer-leave') {
      handlePresencePayload(payload);
      return;
    }

    if (payload.action === 'start' || payload.action === 'cancel') {
      queueOrApplySyncEvent(payload);
    }
  };

  socket.onerror = () => {
    // onclose handles reconnect.
  };

  socket.onclose = () => {
    if (link.socket === socket) {
      link.socket = null;
      link.socketRoomId = null;
    }
    link.connecting = false;
    if (generation !== link.generation || link.roomId !== roomId) return;
    scheduleLinkReconnect(link, roomId, generation);
  };
}

function setRoomSocket(link, roomId) {
  const nextRoomId = roomId || null;
  if (nextRoomId === link.roomId) {
    if (nextRoomId && !link.socket && !link.connecting && !link.reconnectTimer) {
      const generation = ++link.generation;
      link.reconnectDelayMs = SYNC_RECONNECT_MIN_MS;
      connectRoomSocket(link, nextRoomId, generation);
    } else if (nextRoomId && link.kind === 'presence' && localPlayerId) {
      sendPresenceHello(link);
    }
    return;
  }

  closeRoomSocket(link);
  link.outgoingQueue = [];
  link.roomId = nextRoomId;
  link.reconnectDelayMs = SYNC_RECONNECT_MIN_MS;

  if (!link.roomId) return;

  const generation = ++link.generation;
  connectRoomSocket(link, link.roomId, generation);
}

function clearPeerPresence() {
  syncPeerIds = new Set();
  applyPeerBorders();
}

function syncToRooms({ roomId = null, matchId = null, playerId = null } = {}) {
  localPlayerId = playerId ? String(playerId).toLowerCase() : null;

  const nextCooldownRoom = roomId || null;
  const nextPresenceRoom = matchId || roomId || null;

  if (!nextPresenceRoom) {
    clearPeerPresence();
  }

  setRoomSocket(cooldownLink, nextCooldownRoom);

  // Reuse the cooldown socket for presence when both rooms match.
  if (nextPresenceRoom && nextPresenceRoom === nextCooldownRoom) {
    closeRoomSocket(presenceLink);
    presenceLink.roomId = null;
    presenceLink.outgoingQueue = [];
    if (localPlayerId) {
      enqueueLinkMessage(cooldownLink, { action: 'hello', playerId: localPlayerId });
    }
    return;
  }

  setRoomSocket(presenceLink, nextPresenceRoom);
}

function publishSyncEvent(action, enemyIndex, spell, startedAt, durationMs) {
  if (!cooldownLink.roomId) return;

  const payload = { action, enemyIndex, spell };
  if (action === 'start') {
    payload.startedAt = startedAt;
    payload.durationMs = durationMs;
  }

  enqueueLinkMessage(cooldownLink, payload);
}

function applyPeerBorders() {
  document.querySelectorAll('.player-row[data-player-id]').forEach((row) => {
    const id = row.dataset.playerId || '';
    const icon = row.querySelector('.champion-icon');
    if (!icon) return;
    const isPeer = Boolean(id) && id !== localPlayerId && syncPeerIds.has(id);
    icon.classList.toggle('summtracker-user', isPeer);
  });
}

// ── Cooldown timers ──

const timers = {};

function cdKey(playerIndex, type) {
  return `${playerIndex}_${type}`;
}

function startCooldown(playerIndex, type, seconds, startedAt = Date.now()) {
  const key = cdKey(playerIndex, type);
  if (timers[key]) clearInterval(timers[key].interval);

  const endsAt = startedAt + seconds * 1000;
  const btn = document.querySelector(`[data-cd-key="${key}"]`);
  if (!btn) return;

  btn.classList.add('on-cooldown');
  btn.classList.remove('ready');
  const overlay = btn.querySelector('.cooldown-overlay');

  function tick() {
    const remaining = Math.ceil((endsAt - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(timers[key].interval);
      delete timers[key];
      btn.classList.remove('on-cooldown');
      btn.classList.add('ready');
      overlay.textContent = '';
      return;
    }
    overlay.textContent = (settings.format === 'mm:ss' && remaining >= 60)
      ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
      : remaining;
  }

  tick();
  timers[key] = { endsAt, interval: setInterval(tick, 500) };
}

function cancelCooldown(playerIndex, type) {
  const key = cdKey(playerIndex, type);
  if (timers[key]) {
    clearInterval(timers[key].interval);
    delete timers[key];
  }
  const btn = document.querySelector(`[data-cd-key="${key}"]`);
  if (btn) {
    btn.classList.remove('on-cooldown');
    btn.classList.add('ready');
    const overlay = btn.querySelector('.cooldown-overlay');
    if (overlay) overlay.textContent = '';
  }
}

function resetAllCooldowns() {
  Object.values(timers).forEach(({ interval }) => clearInterval(interval));
  Object.keys(timers).forEach(key => delete timers[key]);
}

// ── Player data enrichment ──

function enrichPlayer(player) {
  const items = player.items || [];
  const mode = player.mode || 'unknown';
  const spell1 = applySummonerSpellHaste(getSummonerSpell(player.spell1Id), items, mode);
  const spell2 = applySummonerSpellHaste(getSummonerSpell(player.spell2Id), items, mode);
  const ultCds = applyUltItemHaste(getUltCooldowns(player.championName), items);
  return { ...player, spell1, spell2, ultCds };
}

// ── DDragon helpers ──

function spellIconUrl(spellId) {
  return `${DDragon}/img/spell/${spellId}.png`;
}

function champIconUrl(ddKey) {
  return `${DDragon}/img/champion/${ddKey}.png`;
}

const ultIconCache = {};

function setUltIcon(img, ddKey) {
  if (ultIconCache[ddKey]) {
    img.src = `${DDragon}/img/spell/${ultIconCache[ddKey]}.png`;
    return;
  }
  fetch(`${DDragon}/data/en_US/champion/${ddKey}.json`)
    .then(r => r.json())
    .then(data => {
      const champ = Object.values(data.data)[0];
      const ultId = champ.spells[3].id;
      ultIconCache[ddKey] = ultId;
      img.src = `${DDragon}/img/spell/${ultId}.png`;
    })
    .catch(() => { img.src = champIconUrl(ddKey); });
}

// ── UI builders ──

function buildPlayerRow(player, index, enemyIndex = null) {
  const row = document.createElement('div');
  row.className = 'player-row';
  row.dataset.playerIndex = index;
  const playerId = String(player.playerId || '').toLowerCase();
  if (playerId) row.dataset.playerId = playerId;

  const champImg = document.createElement('img');
  champImg.className = 'champion-icon';
  if (playerId && playerId !== localPlayerId && syncPeerIds.has(playerId)) {
    champImg.classList.add('summtracker-user');
  }
  champImg.src = champIconUrl(player.ddKey);
  champImg.alt = player.championName;
  champImg.onerror = () => { champImg.style.background = '#222'; };

  const info = document.createElement('div');
  info.className = 'player-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  nameEl.textContent = player.summonerName;
  const champEl = document.createElement('div');
  champEl.className = 'champion-name';
  champEl.textContent = player.championName;
  info.appendChild(nameEl);
  info.appendChild(champEl);

  const spells = document.createElement('div');
  spells.className = 'spells';

  spells.appendChild(buildSpellButton(index, 'spell1', player.spell1, player.spell1.cd, enemyIndex));
  spells.appendChild(buildSpellButton(index, 'spell2', player.spell2, player.spell2.cd, enemyIndex));

  const ultGroup = document.createElement('div');
  ultGroup.style.display = 'flex';
  ultGroup.style.alignItems = 'center';
  ultGroup.style.gap = '2px';

  const ultBtn = document.createElement('div');
  ultBtn.className = 'spell-btn ult-btn';
  ultBtn.dataset.cdKey = cdKey(index, 'ult');
  ultBtn.dataset.playerIndex = index;
  ultBtn.dataset.ultCds = JSON.stringify(player.ultCds);
  ultBtn.dataset.baseCd = player.ultCds[Math.max(0, (player.ultLevel || 1) - 1)] || player.ultCds[0];
  ultBtn.title = `${player.championName} Ultimate`;

  const ultImg = document.createElement('img');
  ultImg.alt = 'R';
  setUltIcon(ultImg, player.ddKey);

  const ultOverlay = document.createElement('div');
  ultOverlay.className = 'cooldown-overlay';
  ultBtn.appendChild(ultImg);
  ultBtn.appendChild(ultOverlay);

  let ultLevel = player.ultLevel || 0;

  function applyUltLevel(lvl) {
    ultLevel = lvl;
    pips.querySelectorAll('.ult-pip').forEach(p => {
      p.classList.toggle('active', Number(p.dataset.level) <= ultLevel);
    });
    const cds = JSON.parse(ultBtn.dataset.ultCds || '[120,100,80]');
    ultBtn.dataset.baseCd = cds[Math.max(0, ultLevel - 1)] || cds[0];
  }

  ultBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = cdKey(index, 'ult');
    if (timers[key]) {
      cancelCooldown(index, 'ult');
      if (enemyIndex != null) {
        publishSyncEvent('cancel', enemyIndex, 'ult');
      }
    } else {
      const cd = Number(ultBtn.dataset.baseCd) || 120;
      startCooldown(index, 'ult', cd);
      if (enemyIndex != null) {
        publishSyncEvent('start', enemyIndex, 'ult', Date.now(), Math.round(cd * 1000));
      }
    }
  });

  const pips = document.createElement('div');
  pips.className = 'ult-level';
  pips.dataset.playerIndex = index;
  for (let lvl = 3; lvl >= 1; lvl--) {
    const pip = document.createElement('div');
    pip.className = 'ult-pip' + (lvl <= ultLevel ? ' active' : '');
    pip.dataset.level = lvl;
    pip.addEventListener('click', (e) => {
      e.stopPropagation();
      applyUltLevel(lvl);
    });
    pips.appendChild(pip);
  }

  pips.addEventListener('auto-level', (e) => {
    applyUltLevel(e.detail.ultLevel);
  });

  ultGroup.appendChild(ultBtn);
  ultGroup.appendChild(pips);
  spells.appendChild(ultGroup);

  row.appendChild(champImg);
  row.appendChild(info);
  row.appendChild(spells);

  return row;
}

function buildSpellButton(playerIndex, type, spell, baseCd, enemyIndex = null) {
  const btn = document.createElement('div');
  btn.className = 'spell-btn';
  btn.dataset.playerIndex = playerIndex;
  btn.dataset.spellType = type;
  btn.dataset.cdKey = cdKey(playerIndex, type);
  btn.dataset.baseCd = baseCd;
  btn.title = `${spell.name} (${baseCd}s)`;

  const img = document.createElement('img');
  img.src = spellIconUrl(spell.icon);
  img.alt = spell.name;
  img.onerror = () => {
    if (!img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/spells/icons2d/${spell.icon.toLowerCase()}.png`;
    } else {
      img.style.display = 'none';
    }
  };

  const overlay = document.createElement('div');
  overlay.className = 'cooldown-overlay';

  btn.appendChild(img);
  btn.appendChild(overlay);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = cdKey(playerIndex, type);
    if (timers[key]) {
      cancelCooldown(playerIndex, type);
      if (enemyIndex != null) {
        publishSyncEvent('cancel', enemyIndex, type);
      }
    } else {
      startCooldown(playerIndex, type, baseCd);
      if (enemyIndex != null) {
        publishSyncEvent('start', enemyIndex, type, Date.now(), Math.round(baseCd * 1000));
      }
    }
  });

  return btn;
}

function renderPlayers(players) {
  resetAllCooldowns();
  enemyPlayerIndices = [];

  const allyTeamId  = ownTeam || 'ORDER';
  const enemyTeamId = allyTeamId === 'ORDER' ? 'CHAOS' : 'ORDER';

  const allyEl  = document.getElementById('team-order');
  const enemyEl = document.getElementById('team-chaos');

  allyEl.innerHTML  = '';
  enemyEl.innerHTML = '';

  allyEl.className = 'team-block own-team';
  const allyLabel = document.createElement('div');
  allyLabel.className = 'team-label ally-label';
  allyLabel.textContent = ownTeam ? 'Ally' : 'Blue Side';
  allyEl.appendChild(allyLabel);

  enemyEl.className = 'team-block';
  const enemyLabel = document.createElement('div');
  enemyLabel.className = 'team-label enemy-label';
  enemyLabel.textContent = ownTeam ? 'Enemy' : 'Red Side';
  enemyEl.appendChild(enemyLabel);

  const gameScreen = document.getElementById('game-screen');
  const divider = gameScreen.querySelector('.divider');
  gameScreen.insertBefore(allyEl, divider);

  players.forEach((player, i) => {
    if (player.team === allyTeamId) {
      allyEl.appendChild(buildPlayerRow(player, i));
      return;
    }
    const enemyIndex = enemyPlayerIndices.length;
    enemyPlayerIndices.push(i);
    enemyEl.appendChild(buildPlayerRow(player, i, enemyIndex));
  });

  flushPendingSyncEvents();
}

function showScreen(id) {
  if (preferOpen) setPreferOpen(false);
  currentScreen = id;
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || id !== 'idle-screen');
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || id !== 'game-screen');
  document.getElementById('champ-select-screen').classList.toggle('hidden', settingsOpen || id !== 'champ-select-screen');
  document.getElementById('prefer-panel').classList.add('hidden');
  preferOpen = false;
}

function champName(id) {
  return champById[id]?.name || (id ? `Champ ${id}` : 'None');
}

function champSelectIconUrl(id) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;
}

function setChampSelectStatus(message, kind = '') {
  const el = document.getElementById('cs-status');
  el.textContent = message || '';
  el.className = `cs-status${kind ? ` ${kind}` : ''}`;
}

let champSelectBusy = false;
let lastChampSelect = null;
let lastChampSelectKey = '';
let queuedBenchSwap = null;
let queuedBenchSwapInFlight = false;
let queuedBenchSwapTimer = null;
let queuedBenchMissingTicks = 0;
const QUEUED_SWAP_RETRY_MS = 8;
const QUEUED_SWAP_MISSING_GRACE = 12;

function makeChampTile(championId, title, className = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `champ-tile${className ? ` ${className}` : ''}`;
  btn.title = title;
  btn.dataset.championId = String(championId);
  const img = document.createElement('img');
  img.src = champSelectIconUrl(championId);
  img.alt = champName(championId);
  img.onerror = () => { img.style.background = '#222'; };
  btn.appendChild(img);
  return btn;
}

async function clickChampSelectChampion(championId) {
  if (champSelectBusy || !championId) return;
  const session = lastChampSelect;
  champSelectBusy = true;
  try {
    await invoke('suppress_prefer_list', { championId });
    await invoke('complete_pick', { actionId: session?.pickActionId ?? -1, championId });
    setChampSelectStatus(`Picked ${champName(championId)}`, 'ok');
  } catch (err) {
    setChampSelectStatus(String(err).replace(/^LCU \d+ [^:]+:\s*/, '') || 'Action failed', 'error');
  } finally {
    champSelectBusy = false;
  }
}

function markQueuedBenchTile(championId) {
  document.querySelectorAll('.champ-tile.queued').forEach(tile => {
    tile.classList.remove('queued', 'locked');
  });
  if (!championId) return;
  const tile = document.querySelector(`#cs-bench .champ-tile[data-champion-id="${championId}"]`);
  if (tile) {
    tile.classList.add('queued', 'locked');
    tile.title = `Queued ${champName(championId)} (swaps when unlocked)`;
  }
}

function clearQueuedBenchSwap() {
  queuedBenchSwap = null;
  queuedBenchMissingTicks = 0;
  if (queuedBenchSwapTimer != null) {
    clearTimeout(queuedBenchSwapTimer);
    queuedBenchSwapTimer = null;
  }
  document.querySelectorAll('.champ-tile.queued').forEach(tile => {
    tile.classList.remove('queued', 'locked');
  });
  invoke('set_pending_bench_swap', { championId: null }).catch(() => {});
}

function scheduleQueuedBenchSwap() {
  if (!queuedBenchSwap || queuedBenchSwapTimer != null) return;
  queuedBenchSwapTimer = setTimeout(() => {
    queuedBenchSwapTimer = null;
    attemptQueuedBenchSwap();
  }, QUEUED_SWAP_RETRY_MS);
}

async function attemptQueuedBenchSwap() {
  const queued = queuedBenchSwap;
  if (!queued || queuedBenchSwapInFlight || champSelectBusy) {
    scheduleQueuedBenchSwap();
    return;
  }

  const session = lastChampSelect;
  if (!session || session.state !== 'champ-select') {
    clearQueuedBenchSwap();
    return;
  }
  if (session.myChampionId === queued.championId) {
    clearQueuedBenchSwap();
    setChampSelectStatus(`Swapped to ${champName(queued.championId)}`, 'ok');
    return;
  }

  // Swap already accepted by LCU; wait for session to catch up without re-swapping.
  if (queued.awaitingConfirm) {
    const bench = Array.isArray(session.bench) ? session.bench : [];
    if (bench.includes(queued.championId)) {
      // Still on the bench means the accept did not stick; try again.
      queued.awaitingConfirm = false;
      queued.confirmTicks = 0;
    } else {
      queued.confirmTicks = (queued.confirmTicks || 0) + 1;
      if (queued.confirmTicks > 40) {
        queued.awaitingConfirm = false;
        queued.confirmTicks = 0;
      } else {
        setChampSelectStatus(`Swapping to ${champName(queued.championId)}...`, 'queued');
        scheduleQueuedBenchSwap();
        return;
      }
    }
  }

  const bench = Array.isArray(session.bench) ? session.bench : [];
  if (!bench.includes(queued.championId)) {
    queuedBenchMissingTicks += 1;
    if (queuedBenchMissingTicks >= QUEUED_SWAP_MISSING_GRACE) {
      clearQueuedBenchSwap();
      setChampSelectStatus(`${champName(queued.championId)} left the bench`, 'error');
      return;
    }
    setChampSelectStatus(`Queued ${champName(queued.championId)} (waiting to unlock)`, 'queued');
    scheduleQueuedBenchSwap();
    return;
  }
  queuedBenchMissingTicks = 0;

  queuedBenchSwapInFlight = true;
  try {
    await invoke('swap_bench', { championId: queued.championId });
    if (queuedBenchSwap === queued) {
      queued.awaitingConfirm = true;
      setChampSelectStatus(`Swapping to ${champName(queued.championId)}...`, 'queued');
      scheduleQueuedBenchSwap();
    }
  } catch (_) {
    if (queuedBenchSwap === queued) {
      queued.awaitingConfirm = false;
      markQueuedBenchTile(queued.championId);
      setChampSelectStatus(`Queued ${champName(queued.championId)} (waiting to unlock)`, 'queued');
      scheduleQueuedBenchSwap();
    }
  } finally {
    queuedBenchSwapInFlight = false;
  }
}

function queueBenchSwap(championId) {
  if (!championId) return;
  if (queuedBenchSwap?.championId === championId) {
    clearQueuedBenchSwap();
    setChampSelectStatus('Queue cleared', '');
    return;
  }
  queuedBenchSwap = { championId, awaitingConfirm: false, confirmTicks: 0 };
  queuedBenchMissingTicks = 0;
  markQueuedBenchTile(championId);
  setChampSelectStatus(`Queued ${champName(championId)} (waiting to unlock)`, 'queued');
  invoke('set_pending_bench_swap', { championId }).catch(() => {});
  attemptQueuedBenchSwap();
}

async function clickAllyTrade(ally) {
  if (champSelectBusy) return;
  const latest = lastChampSelect?.allies?.find(a => a.cellId === ally.cellId) || ally;
  if (latest?.tradeId == null) return;
  const state = String(latest.tradeState || '').toUpperCase();
  const kind = latest.tradeKind || 'champion-swap';
  if (state !== 'RECEIVED' && state !== 'AVAILABLE') return;
  champSelectBusy = true;
  try {
    await invoke('suppress_prefer_list', { championId: latest.championId || null });
    if (state === 'RECEIVED') {
      await invoke('accept_trade', { tradeId: latest.tradeId, kind });
      setChampSelectStatus(`Accepted trade for ${champName(latest.championId)}`, 'ok');
    } else {
      await invoke('request_trade', { tradeId: latest.tradeId, kind });
      setChampSelectStatus(`Trade requested for ${champName(latest.championId)}`, 'ok');
    }
  } catch (err) {
    setChampSelectStatus(String(err).replace(/^LCU \d+ [^:]+:\s*/, '') || 'Trade failed', 'error');
  } finally {
    champSelectBusy = false;
  }
}

function champSelectKey(data) {
  return JSON.stringify({
    mode: data.mode,
    my: data.myChampionId,
    pick: data.pickActionId,
    bench: data.bench,
    cards: data.cards,
    prefer: data.preferTargetId || 0,
    allies: (data.allies || []).map(a => [
      a.cellId, a.championId, a.tradeState, a.tradeId, a.displayName, a.tradeKind,
    ]),
  });
}

function champSelectBenchKey(data) {
  return JSON.stringify({
    bench: data.bench,
    prefer: data.preferTargetId || 0,
    my: data.myChampionId || 0,
    queued: queuedBenchSwap?.championId || 0,
  });
}

function champSelectAlliesKey(data) {
  return JSON.stringify({
    my: data.myChampionId,
    pick: data.pickActionId,
    cards: data.cards,
    phase: data.phase,
    allies: (data.allies || []).map(a => [
      a.cellId, a.championId, a.tradeState, a.tradeId, a.displayName, a.tradeKind,
    ]),
  });
}

let lastChampSelectBenchKey = '';
let lastChampSelectAlliesKey = '';

function renderChampSelectBench(data) {
  const bench = Array.isArray(data.bench) ? data.bench.filter(id => id > 0) : [];
  const benchWrap = document.getElementById('cs-bench-wrap');
  const benchEl = document.getElementById('cs-bench');
  benchEl.innerHTML = '';
  benchWrap.classList.toggle('hidden', bench.length === 0);
  const preferTargetId = Number(data.preferTargetId || 0);
  const preferActive = preferTargetId > 0
    && preferTargetId !== (data.myChampionId || 0)
    && bench.includes(preferTargetId)
    && !queuedBenchSwap;
  if (preferActive) {
    setChampSelectStatus(`Prefer: ${champName(preferTargetId)}`, 'queued');
  } else if (!queuedBenchSwap && document.getElementById('cs-status')?.classList.contains('queued')) {
    const text = document.getElementById('cs-status').textContent || '';
    if (text.startsWith('Prefer:')) setChampSelectStatus('', '');
  }
  bench.forEach(id => {
    const isQueued = queuedBenchSwap?.championId === id || (preferActive && preferTargetId === id);
    const classes = [isQueued ? 'queued' : '', isQueued ? 'locked' : ''].filter(Boolean).join(' ');
    const title = queuedBenchSwap?.championId === id
      ? `Queued ${champName(id)} (swaps when unlocked)`
      : preferActive && preferTargetId === id
        ? `Prefer target: ${champName(id)}`
        : `Swap to ${champName(id)} (queues if locked)`;
    const tile = makeChampTile(id, title, classes);
    tile.addEventListener('click', () => queueBenchSwap(id));
    benchEl.appendChild(tile);
  });
}

function renderChampSelect(data) {
  const key = champSelectKey(data);
  if (key === lastChampSelectKey) {
    lastChampSelect = data;
    return false;
  }
  lastChampSelectKey = key;
  lastChampSelect = data;
  const modeLabel = document.getElementById('cs-mode-label');
  modeLabel.textContent = data.mode || 'ARAM';

  const alliesKey = champSelectAlliesKey(data);
  const benchKey = champSelectBenchKey(data);
  const alliesChanged = alliesKey !== lastChampSelectAlliesKey;
  const benchChanged = benchKey !== lastChampSelectBenchKey;

  if (alliesChanged) {
    lastChampSelectAlliesKey = alliesKey;
    const youEl = document.getElementById('cs-you');
    youEl.innerHTML = '';
    const myId = data.myChampionId || 0;
    if (myId) {
      const tile = makeChampTile(myId, champName(myId), 'local');
      youEl.appendChild(tile);
      const name = document.createElement('div');
      name.className = 'player-info';
      name.innerHTML = `<div class="player-name">${champName(myId)}</div><div class="champion-name">You</div>`;
      youEl.appendChild(name);
    } else {
      const waiting = document.createElement('div');
      waiting.className = 'champion-name';
      waiting.textContent = data.pickActionId != null ? 'Pick one of your cards' : 'Waiting for champion...';
      youEl.appendChild(waiting);
    }

    const cards = Array.isArray(data.cards) ? data.cards.filter(id => id > 0) : [];
    const cardsWrap = document.getElementById('cs-cards-wrap');
    const cardsEl = document.getElementById('cs-cards');
    cardsEl.innerHTML = '';
    const phase = String(data.phase || '').toUpperCase();
    const needsPick = data.pickActionId != null || phase.includes('CARD') || phase.includes('PICK');
    const showCards = cards.length > 0 && needsPick && !myId;
    cardsWrap.classList.toggle('hidden', !showCards);
    if (showCards) {
      cards.forEach(id => {
        const tile = makeChampTile(id, `Pick ${champName(id)}`);
        tile.addEventListener('click', () => clickChampSelectChampion(id));
        cardsEl.appendChild(tile);
      });
    }

    const alliesEl = document.getElementById('cs-allies');
    alliesEl.innerHTML = '';
    (data.allies || []).forEach(ally => {
      if (ally.isLocal) return;
      const row = document.createElement('div');
      row.className = 'ally-row';
      const state = String(ally.tradeState || '').toUpperCase();

      const img = document.createElement('img');
      img.className = 'champion-icon';
      img.src = ally.championId ? champSelectIconUrl(ally.championId) : '';
      img.alt = champName(ally.championId);
      if (state === 'AVAILABLE' || state === 'RECEIVED') {
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => clickAllyTrade(ally));
      }
      row.appendChild(img);

      const info = document.createElement('div');
      info.className = 'player-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      nameEl.textContent = ally.displayName || champName(ally.championId);
      const champEl = document.createElement('div');
      champEl.className = 'champion-name';
      champEl.textContent = champName(ally.championId);
      info.appendChild(nameEl);
      info.appendChild(champEl);
      row.appendChild(info);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'ally-action';
      if (state === 'RECEIVED') {
        action.textContent = 'Accept';
        action.classList.add('accept');
        action.addEventListener('click', () => clickAllyTrade(ally));
      } else if (state === 'SENT') {
        action.textContent = 'Sent';
        action.disabled = true;
      } else if (state === 'AVAILABLE') {
        action.textContent = 'Trade';
        action.addEventListener('click', () => clickAllyTrade(ally));
      } else {
        action.textContent = state === 'BUSY' ? 'Busy' : 'Locked';
        action.disabled = true;
      }
      row.appendChild(action);
      alliesEl.appendChild(row);
    });
  }

  if (benchChanged) {
    lastChampSelectBenchKey = benchKey;
    renderChampSelectBench(data);
  }

  return alliesChanged || benchChanged;
}

function applySyncCooldownEvent(event) {
  if (!event || event.enemyIndex == null || !event.spell) return false;
  const playerIndex = enemyPlayerIndices[event.enemyIndex];
  if (playerIndex == null) return false;
  if (event.action === 'cancel') { cancelCooldown(playerIndex, event.spell); return true; }
  if (event.action === 'start' && event.durationMs != null && event.startedAt != null) {
    startCooldown(playerIndex, event.spell, event.durationMs / 1000, event.startedAt);
    return true;
  }
  return false;
}

function queueOrApplySyncEvent(event) {
  if (!applySyncCooldownEvent(event)) pendingSyncEvents.push(event);
}

function flushPendingSyncEvents() {
  if (pendingSyncEvents.length === 0) return;
  pendingSyncEvents = pendingSyncEvents.filter(event => !applySyncCooldownEvent(event));
}

function handleGameData(data) {
  if (data.state === 'in-game' && data.players) {
    clearQueuedBenchSwap();
    ownTeam = data.ownTeam || null;
    const enriched = data.players.map(enrichPlayer);
    renderPlayers(enriched);
    document.getElementById('titlebar-label').textContent = 'SummTracker';
    showScreen('game-screen');
    if (!settingsOpen) invoke('set_focusable', { focusable: false, stealFocus: false });
    syncGameHeight();
    syncToRooms({
      roomId: data.roomId || null,
      matchId: data.matchId || null,
      playerId: data.localPlayerId || null,
    });
  } else if (data.state === 'champ-select' && data.benchEnabled) {
    const entering = !document.body.classList.contains('champ-select-active');
    if (entering) {
      resetAllCooldowns();
      enemyPlayerIndices = [];
      pendingSyncEvents = [];
      syncToRooms();
      document.body.classList.add('champ-select-active');
      showScreen('champ-select-screen');
      // Only once on enter. Polling this every tick made clicks feel laggy.
      invoke('set_focusable', { focusable: true, stealFocus: false });
    }
    const layoutChanged = renderChampSelect(data);
    if (queuedBenchSwap) attemptQueuedBenchSwap();
    if (entering || layoutChanged) {
      document.getElementById('titlebar-label').textContent = data.mode || 'ARAM';
      syncGameHeight(entering);
    }
  } else {
    clearQueuedBenchSwap();
    document.body.classList.remove('champ-select-active');
    resetAllCooldowns();
    enemyPlayerIndices = [];
    pendingSyncEvents = [];
    syncToRooms();
    document.getElementById('titlebar-label').textContent = 'SummTracker';
    showScreen('idle-screen');
    lastChampSelect = null;
    lastChampSelectKey = '';
    lastChampSelectBenchKey = '';
    lastChampSelectAlliesKey = '';
    if (!settingsOpen) invoke('set_focusable', { focusable: false, stealFocus: false });
  }
}

// ── Titlebar controls ──

document.getElementById('collapse-btn').addEventListener('click', () => {
  invoke('toggle_collapse');
});

document.getElementById('settings-btn').addEventListener('click', toggleSettings);

document.getElementById('close-btn').addEventListener('click', () => {
  invoke('quit_app');
});

// ── Tauri event listeners ──

listen('sync-collapse', (event) => {
  document.body.classList.toggle('collapsed', event.payload);
  if (!event.payload) syncGameHeight(true);
});

listen('game-data', (event) => {
  handleGameData(event.payload);
});

listen('player-levels', (event) => {
  event.payload.forEach(({ playerIndex, ultLevel }) => {
    const pips = document.querySelector(`.ult-level[data-player-index="${playerIndex}"]`);
    if (pips) pips.dispatchEvent(new CustomEvent('auto-level', { detail: { ultLevel } }));
  });
});

listen('player-cooldowns', (event) => {
  event.payload.forEach(({ playerIndex, spell1Id, spell2Id, championName, items, mode }) => {
    const spell1 = applySummonerSpellHaste(getSummonerSpell(spell1Id), items, mode);
    const spell2 = applySummonerSpellHaste(getSummonerSpell(spell2Id), items, mode);
    const ultCds = applyUltItemHaste(getUltCooldowns(championName), items);

    const spell1Btn = document.querySelector(`.spell-btn[data-player-index="${playerIndex}"][data-spell-type="spell1"]`);
    if (spell1Btn) {
      spell1Btn.dataset.baseCd = spell1.cd;
      spell1Btn.title = `${spell1.name} (${spell1.cd}s)`;
    }

    const spell2Btn = document.querySelector(`.spell-btn[data-player-index="${playerIndex}"][data-spell-type="spell2"]`);
    if (spell2Btn) {
      spell2Btn.dataset.baseCd = spell2.cd;
      spell2Btn.title = `${spell2.name} (${spell2.cd}s)`;
    }

    const ultBtn = document.querySelector(`.ult-btn[data-player-index="${playerIndex}"]`);
    if (ultBtn && ultCds.length) {
      ultBtn.dataset.ultCds = JSON.stringify(ultCds);
      const pips = document.querySelector(`.ult-level[data-player-index="${playerIndex}"]`);
      const activePips = pips ? pips.querySelectorAll('.ult-pip.active').length : 0;
      const ultLevel = activePips || 1;
      ultBtn.dataset.baseCd = ultCds[Math.max(0, ultLevel - 1)] || ultCds[0];
    }
  });
});

// ── Init ──

invoke('load_settings').then(saved => {
  settings = { ...DEFAULT_SETTINGS, ...saved };
  settings.preferList = normalizePreferList(settings.preferList);
  initSettingsPanel();
  applySettings();
  invoke('update_collapse_bind', { bind: settings.collapseBind });
  invoke('close_prefer_list_window').catch(() => {});
  invoke('set_focusable', { focusable: false, stealFocus: false });
  invoke('get_latest_game_data').then(handleGameData).catch(() => {});
});

initItemHaste();
