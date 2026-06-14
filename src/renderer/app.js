// ── Settings ──

const DEFAULT_SETTINGS = {
  showOwnTeam: true,
  showChampName: true,
  showSummonerName: true,
  format: 'mm:ss',
  opacity: 90,
};

let settings = { ...DEFAULT_SETTINGS };

let ownTeam = null;

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
  document.getElementById('app').style.opacity = opacity / 100;
  const opacitySlider = document.getElementById('s-opacity');
  if (opacitySlider) {
    opacitySlider.value = opacity;
    document.getElementById('s-opacity-value').textContent = `${opacity}%`;
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
}

let settingsOpen = false;

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-btn').classList.toggle('active', settingsOpen);
  document.getElementById('settings-panel').classList.toggle('hidden', !settingsOpen);
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'game-screen');
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || currentScreen !== 'idle-screen');

  // Resize to fit game content when closing settings (game screen now visible and measurable)
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

function startCooldown(playerIndex, type, seconds) {
  const key = cdKey(playerIndex, type);
  if (timers[key]) {
    clearInterval(timers[key].interval);
  }

  const endsAt = Date.now() + seconds * 1000;
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

function buildPlayerRow(player, index) {
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
  spells.appendChild(buildSpellButton(index, 'spell1', player.spell1, player.spell1.cd));
  // Summoner spell 2
  spells.appendChild(buildSpellButton(index, 'spell2', player.spell2, player.spell2.cd));

  // Ult button + level pips
  const ultGroup = document.createElement('div');
  ultGroup.style.display = 'flex';
  ultGroup.style.alignItems = 'center';
  ultGroup.style.gap = '2px';

  const ultBtn = document.createElement('div');
  ultBtn.className = 'spell-btn ult-btn';
  ultBtn.dataset.cdKey = cdKey(index, 'ult');
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
    } else {
      const cd = Number(ultBtn.dataset.baseCd) || 120;
      startCooldown(index, 'ult', cd);
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

function buildSpellButton(playerIndex, type, spell, baseCd) {
  const btn = document.createElement('div');
  btn.className = 'spell-btn';
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
    } else {
      startCooldown(playerIndex, type, baseCd);
    }
  });

  return btn;
}

function renderPlayers(players) {
  resetAllCooldowns();

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
    const row = buildPlayerRow(player, i);
    if (player.team === allyTeamId) allyEl.appendChild(row);
    else enemyEl.appendChild(row);
  });
}

function showScreen(id) {
  currentScreen = id;
  document.getElementById('idle-screen').classList.toggle('hidden', settingsOpen || id !== 'idle-screen');
  document.getElementById('game-screen').classList.toggle('hidden', settingsOpen || id !== 'game-screen');
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
