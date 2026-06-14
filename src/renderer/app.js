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
  window.overlay.saveSettings(settings);
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
  // Apply opacity only to background, keep text fully opaque
  const bgAlpha = (opacity / 100).toFixed(2);
  app.style.setProperty('--bg-opacity', bgAlpha);
  // As background fades, add text shadow for readability
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
    // Height sync happens when settings closes — game screen must be visible to measure
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
      if (e.key === 'Escape') {
        settings.collapseBind = null;
      } else {
        settings.collapseBind = {
          key: e.key.toLowerCase(),
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
        };
      }
      listeningForBind = false;
      bindBtn.classList.remove('listening');
      saveSettings();
      applySettings();
      return;
    }

    if (settings.collapseBind && e.key.toLowerCase() === settings.collapseBind.key &&
        e.shiftKey === settings.collapseBind.shift &&
        e.ctrlKey === settings.collapseBind.ctrl &&
        e.altKey === settings.collapseBind.alt) {
      document.getElementById('collapse-btn').click();
    }
  }, true);
}

let settingsOpen = false;

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-btn').classList.toggle('active', settingsOpen);
  document.getElementById('settings-panel').classList.toggle('hidden', !settingsOpen);
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'game-screen');
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'idle-screen');

  window.overlay.setFocusable(settingsOpen);

  if (!settingsOpen && currentScreen === 'game-screen') {
    syncGameHeight();
  }
}

let currentScreen = 'idle-screen';

// ── Scaling ──

const NATURAL_WIDTH = 320;

function updateScale() {
  const scale = window.innerWidth / NATURAL_WIDTH;
  document.getElementById('app').style.transform = `scale(${scale})`;
}

// Measure the game screen height and tell main process to resize window to fit.
// Must be called while the game screen is visible (not while settings is open).
function syncGameHeight() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const app = document.getElementById('app');
    const h = app.scrollHeight;
    if (h > 0) window.overlay.sendNaturalHeight(h);
  }));
}

new ResizeObserver(updateScale).observe(document.body);

let DDragon = 'https://ddragon.leagueoflegends.com/cdn/14.24.1'; // fallback

fetch('https://ddragon.leagueoflegends.com/api/versions.json')
  .then(r => r.json())
  .then(versions => { DDragon = `https://ddragon.leagueoflegends.com/cdn/${versions[0]}`; })
  .catch(() => {});

// Active cooldown timers: { [key]: { endsAt, interval } }
const timers = {};

function cdKey(playerIndex, type) {
  return `${playerIndex}_${type}`;
}

function startCooldown(playerIndex, type, seconds, startedAt = Date.now()) {
  const key = cdKey(playerIndex, type);
  if (timers[key]) {
    clearInterval(timers[key].interval);
  }

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

function spellIconUrl(spellId) {
  return `${DDragon}/img/spell/${spellId}.png`;
}

function champIconUrl(ddKey) {
  return `${DDragon}/img/champion/${ddKey}.png`;
}

// Cache of ddKey → ult spell icon filename (fetched from DDragon champion data)
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
    .catch(() => {
      img.src = champIconUrl(ddKey);
    });
}

function buildPlayerRow(player, index, enemyIndex = null) {
  const row = document.createElement('div');
  row.className = 'player-row';
  row.dataset.playerIndex = index;

  // Champion icon
  const champImg = document.createElement('img');
  champImg.className = 'champion-icon';
  champImg.src = champIconUrl(player.ddKey);
  champImg.alt = player.championName;
  champImg.onerror = () => { champImg.style.background = '#222'; };

  // Player info
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

  // Spells container
  const spells = document.createElement('div');
  spells.className = 'spells';

  // Summoner spell 1
  spells.appendChild(buildSpellButton(index, 'spell1', player.spell1, player.spell1.cd, enemyIndex));
  // Summoner spell 2
  spells.appendChild(buildSpellButton(index, 'spell2', player.spell2, player.spell2.cd, enemyIndex));

  // Ult button + level pips
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

  ultBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = cdKey(index, 'ult');
    if (timers[key]) {
      cancelCooldown(index, 'ult');
      if (enemyIndex != null) {
        window.overlay.sendSyncCooldownEvent({ action: 'cancel', enemyIndex, spell: 'ult' });
      }
    } else {
      const cd = Number(ultBtn.dataset.baseCd) || 120;
      startCooldown(index, 'ult', cd);
      if (enemyIndex != null) {
        window.overlay.sendSyncCooldownEvent({
          action: 'start',
          enemyIndex,
          spell: 'ult',
          startedAt: Date.now(),
          durationMs: Math.round(cd * 1000),
        });
      }
    }
  });

  function applyUltLevel(lvl) {
    ultLevel = lvl;
    pips.querySelectorAll('.ult-pip').forEach(p => {
      p.classList.toggle('active', Number(p.dataset.level) <= ultLevel);
    });
    const cds = JSON.parse(ultBtn.dataset.ultCds || '[120,100,80]');
    ultBtn.dataset.baseCd = cds[Math.max(0, ultLevel - 1)] || cds[0];
  }

  // Ult level pips
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
      window.overlay.sendUltLevelChanged(index, ultLevel);
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
        window.overlay.sendSyncCooldownEvent({ action: 'cancel', enemyIndex, spell: type });
      }
    } else {
      startCooldown(playerIndex, type, baseCd);
      if (enemyIndex != null) {
        window.overlay.sendSyncCooldownEvent({
          action: 'start',
          enemyIndex,
          spell: type,
          startedAt: Date.now(),
          durationMs: Math.round(baseCd * 1000),
        });
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

  // Ally block
  allyEl.className = `team-block own-team`;
  const allyLabel = document.createElement('div');
  allyLabel.className = 'team-label ally-label';
  allyLabel.textContent = ownTeam ? 'Ally' : 'Blue Side';
  allyEl.appendChild(allyLabel);

  // Enemy block
  enemyEl.className = 'team-block';
  const enemyLabel = document.createElement('div');
  enemyLabel.className = 'team-label enemy-label';
  enemyLabel.textContent = ownTeam ? 'Enemy' : 'Red Side';
  enemyEl.appendChild(enemyLabel);

  // Put ally team first visually
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
}

function applySyncCooldownEvent(event) {
  if (!event || event.enemyIndex == null || !event.spell) return false;

  const playerIndex = enemyPlayerIndices[event.enemyIndex];
  if (playerIndex == null) return false;

  if (event.action === 'cancel') {
    cancelCooldown(playerIndex, event.spell);
    return true;
  }

  if (event.action === 'start' && event.durationMs != null && event.startedAt != null) {
    startCooldown(playerIndex, event.spell, event.durationMs / 1000, event.startedAt);
    return true;
  }

  return false;
}

function queueOrApplySyncEvent(event) {
  if (!applySyncCooldownEvent(event)) {
    pendingSyncEvents.push(event);
  }
}

function flushPendingSyncEvents() {
  if (pendingSyncEvents.length === 0) return;

  pendingSyncEvents = pendingSyncEvents.filter(event => !applySyncCooldownEvent(event));
}

// ── Titlebar controls ──

document.getElementById('collapse-btn').addEventListener('click', () => {
  document.body.classList.toggle('collapsed');
  window.overlay.sendToggleCollapse();
});

document.getElementById('settings-btn').addEventListener('click', toggleSettings);

document.getElementById('close-btn').addEventListener('click', () => {
  window.overlay.sendQuit();
});

window.overlay.loadSettings().then(saved => {
  settings = { ...DEFAULT_SETTINGS, ...saved };
  initSettingsPanel();
  applySettings();
});

// ── IPC listeners ──

window.overlay.onGameData((data) => {
  if (data.state === 'in-game' && data.players) {
    ownTeam = data.ownTeam || null;
    renderPlayers(data.players);
    showScreen('game-screen');
    syncGameHeight();
  } else {
    resetAllCooldowns();
    enemyPlayerIndices = [];
    pendingSyncEvents = [];
    showScreen('idle-screen');
  }
});

window.overlay.onPlayerLevels((updates) => {
  updates.forEach(({ playerIndex, ultLevel }) => {
    // Find the pips container for this player and trigger applyUltLevel via a custom event
    const pips = document.querySelector(`.ult-level[data-player-index="${playerIndex}"]`);
    if (pips) {
      pips.dispatchEvent(new CustomEvent('auto-level', { detail: { ultLevel } }));
    }
  });
});

window.overlay.onPlayerCooldowns((updates) => {
  updates.forEach(({ playerIndex, spell1Cd, spell2Cd, ultCds }) => {
    const spell1Btn = document.querySelector(`.spell-btn[data-player-index="${playerIndex}"][data-spell-type="spell1"]`);
    if (spell1Btn) {
      spell1Btn.dataset.baseCd = spell1Cd;
      spell1Btn.title = `${spell1Btn.querySelector('img')?.alt || 'Spell'} (${spell1Cd}s)`;
    }

    const spell2Btn = document.querySelector(`.spell-btn[data-player-index="${playerIndex}"][data-spell-type="spell2"]`);
    if (spell2Btn) {
      spell2Btn.dataset.baseCd = spell2Cd;
      spell2Btn.title = `${spell2Btn.querySelector('img')?.alt || 'Spell'} (${spell2Cd}s)`;
    }

    const ultBtn = document.querySelector(`.ult-btn[data-player-index="${playerIndex}"]`);
    if (ultBtn && Array.isArray(ultCds)) {
      ultBtn.dataset.ultCds = JSON.stringify(ultCds);
      const pips = document.querySelector(`.ult-level[data-player-index="${playerIndex}"]`);
      const activePips = pips ? pips.querySelectorAll('.ult-pip.active').length : 0;
      const ultLevel = activePips || 1;
      ultBtn.dataset.baseCd = ultCds[Math.max(0, ultLevel - 1)] || ultCds[0];
    }
  });
});

window.overlay.onSyncCooldownEvent((event) => {
  queueOrApplySyncEvent(event);
});

window.overlay.onSyncCooldownSnapshot((events) => {
  resetAllCooldowns();
  pendingSyncEvents = [];
  events.forEach(event => queueOrApplySyncEvent(event));
});

