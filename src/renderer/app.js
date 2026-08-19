import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createClient } from '@supabase/supabase-js';
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
};

let settings = { ...DEFAULT_SETTINGS };

let ownTeam = null;
let enemyPlayerIndices = [];
let pendingSyncEvents = [];

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

function isBindMatch(event, bind) {
  if (!bind || !bind.key) return false;
  return event.key.toLowerCase() === bind.key.toLowerCase()
    && Boolean(event.shiftKey) === Boolean(bind.shift)
    && Boolean(event.ctrlKey) === Boolean(bind.ctrl)
    && Boolean(event.altKey) === Boolean(bind.alt);
}

let settingsOpen = false;

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-btn').classList.toggle('active', settingsOpen);
  document.getElementById('settings-panel').classList.toggle('hidden', !settingsOpen);
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'game-screen');
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'idle-screen');
  document.getElementById('champ-select-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'champ-select-screen');

  invoke('set_focusable', { focusable: settingsOpen || currentScreen === 'champ-select-screen' });
  syncGameHeight();
}

let currentScreen = 'idle-screen';

// ── Scaling ──

function updateScale() {
  const scale = document.body.clientWidth / 320;
  document.getElementById('app').style.transform = `scale(${scale})`;
}

function syncGameHeight() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const app = document.getElementById('app');
    const h = app.scrollHeight;
    if (h > 0) invoke('set_natural_height', { height: h });
  }));
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

// ── Supabase room sync ──

const SUPABASE_URL = 'https://sjodltcylcxvauvgabot.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ex94Isy1_u-qzXJWJEqeQg_9nhGkohm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let syncRoomId = null;
let syncChannel = null;

async function syncToRoom(roomId) {
  if (roomId === syncRoomId) return;

  if (syncChannel) {
    await supabase.removeChannel(syncChannel);
    syncChannel = null;
  }

  syncRoomId = roomId;

  if (!syncRoomId) return;

  const { data } = await supabase
    .from('cooldowns')
    .select('enemy_index, spell, started_at, duration_ms')
    .eq('room_id', syncRoomId)
    .gt('duration_ms', 0);

  if (data) {
    data.forEach(row => queueOrApplySyncEvent({
      action: 'start',
      enemyIndex: row.enemy_index,
      spell: row.spell,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
    }));
  }

  syncChannel = supabase
    .channel(`cooldowns:${syncRoomId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cooldowns', filter: `room_id=eq.${syncRoomId}` },
      payload => queueOrApplySyncEvent({
        action: 'start',
        enemyIndex: payload.new.enemy_index,
        spell: payload.new.spell,
        startedAt: payload.new.started_at,
        durationMs: payload.new.duration_ms,
      }))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cooldowns', filter: `room_id=eq.${syncRoomId}` },
      payload => queueOrApplySyncEvent({
        action: payload.new.duration_ms > 0 ? 'start' : 'cancel',
        enemyIndex: payload.new.enemy_index,
        spell: payload.new.spell,
        startedAt: payload.new.started_at,
        durationMs: payload.new.duration_ms,
      }))
    .subscribe();
}

async function publishSyncEvent(action, enemyIndex, spell, startedAt, durationMs) {
  if (!syncRoomId) return;

  const match = { room_id: syncRoomId, enemy_index: enemyIndex, spell };
  const { data: existing } = await supabase
    .from('cooldowns').select('id').match(match)
    .order('updated_at', { ascending: false }).limit(1);

  const nextValues = action === 'start'
    ? { ...match, started_at: startedAt, duration_ms: durationMs, updated_at: new Date().toISOString() }
    : { started_at: 0, duration_ms: 0, updated_at: new Date().toISOString() };

  if (existing?.length) {
    await supabase.from('cooldowns').update(nextValues).eq('id', existing[0].id);
  } else if (action === 'start') {
    await supabase.from('cooldowns').insert(nextValues);
  }
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

  const champImg = document.createElement('img');
  champImg.className = 'champion-icon';
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
  currentScreen = id;
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || id !== 'idle-screen');
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || id !== 'game-screen');
  document.getElementById('champ-select-screen').classList.toggle('hidden', settingsOpen || id !== 'champ-select-screen');
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
    if (session?.pickActionId != null && !session.myChampionId) {
      await invoke('complete_pick', { actionId: session.pickActionId, championId });
      setChampSelectStatus(`Picked ${champName(championId)}`, 'ok');
    } else {
      await invoke('swap_bench', { championId });
      setChampSelectStatus(`Swapped to ${champName(championId)}`, 'ok');
    }
  } catch (err) {
    setChampSelectStatus(String(err).replace(/^LCU \d+ [^:]+:\s*/, '') || 'Swap failed', 'error');
  } finally {
    champSelectBusy = false;
  }
}

async function clickAllyTrade(ally) {
  if (champSelectBusy || ally?.tradeId == null) return;
  const state = String(ally.tradeState || '').toUpperCase();
  const kind = ally.tradeKind || 'trade';
  champSelectBusy = true;
  try {
    if (state === 'RECEIVED') {
      await invoke('accept_trade', { tradeId: ally.tradeId, kind });
      setChampSelectStatus(`Accepted trade for ${champName(ally.championId)}`, 'ok');
    } else if (state === 'AVAILABLE') {
      await invoke('request_trade', { tradeId: ally.tradeId, kind });
      setChampSelectStatus(`Trade requested for ${champName(ally.championId)}`, 'ok');
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
    allies: (data.allies || []).map(a => [
      a.cellId, a.championId, a.tradeState, a.tradeId, a.displayName, a.tradeKind,
    ]),
  });
}

function renderChampSelect(data) {
  const key = champSelectKey(data);
  if (key === lastChampSelectKey) {
    lastChampSelect = data;
    return;
  }
  lastChampSelectKey = key;
  lastChampSelect = data;
  const modeLabel = document.getElementById('cs-mode-label');
  modeLabel.textContent = data.mode || 'ARAM';

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
  const showCards = cards.length > 0 && !myId;
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

  const bench = Array.isArray(data.bench) ? data.bench.filter(id => id > 0) : [];
  const benchWrap = document.getElementById('cs-bench-wrap');
  const benchEl = document.getElementById('cs-bench');
  benchEl.innerHTML = '';
  benchWrap.classList.toggle('hidden', bench.length === 0);
  bench.forEach(id => {
    const tile = makeChampTile(id, `Swap to ${champName(id)}`);
    tile.addEventListener('click', () => clickChampSelectChampion(id));
    benchEl.appendChild(tile);
  });
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
    ownTeam = data.ownTeam || null;
    const enriched = data.players.map(enrichPlayer);
    renderPlayers(enriched);
    document.getElementById('titlebar-label').textContent = 'SummTracker';
    showScreen('game-screen');
    if (!settingsOpen) invoke('set_focusable', { focusable: false });
    syncGameHeight();
    syncToRoom(data.roomId || null);
  } else if (data.state === 'champ-select' && data.benchEnabled) {
    resetAllCooldowns();
    enemyPlayerIndices = [];
    pendingSyncEvents = [];
    syncToRoom(null);
    renderChampSelect(data);
    document.getElementById('titlebar-label').textContent = data.mode || 'ARAM';
    showScreen('champ-select-screen');
    invoke('set_focusable', { focusable: true });
    syncGameHeight();
  } else {
    resetAllCooldowns();
    enemyPlayerIndices = [];
    pendingSyncEvents = [];
    syncToRoom(null);
    document.getElementById('titlebar-label').textContent = 'SummTracker';
    showScreen('idle-screen');
    lastChampSelect = null;
    lastChampSelectKey = '';
    if (!settingsOpen) invoke('set_focusable', { focusable: false });
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

window.addEventListener('keydown', (event) => {
  if (settingsOpen) return;
  if (!isBindMatch(event, settings.collapseBind)) return;
  event.preventDefault();
  invoke('toggle_collapse');
}, true);

// ── Tauri event listeners ──

listen('sync-collapse', (event) => {
  document.body.classList.toggle('collapsed', event.payload);
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
  initSettingsPanel();
  applySettings();
  invoke('update_collapse_bind', { bind: settings.collapseBind });
  invoke('set_focusable', { focusable: false });
  invoke('get_latest_game_data').then(handleGameData).catch(() => {});
});

initItemHaste();
