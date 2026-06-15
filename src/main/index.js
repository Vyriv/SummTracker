const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { isClientRunning, getChampSelectSession, getGameflowSession } = require('./lcu');
const { getAllPlayers, getAllGameData, isGameRunning, getActivePlayer } = require('./live-game');
const { getSummonerSpell, getUltCooldowns, getUltLevelFromChampLevel, applyUltItemHaste, applySummonerSpellHaste, initCooldowns } = require('./cooldowns');
const { getForegroundWindowInfo, isLeagueGameWindow } = require('./windows');

const COLLAPSED_HEIGHT = 32;
const NATURAL_WIDTH = 320;
const BOUNDS_FILE    = path.join(app.getPath('userData'), 'bounds.json');
const SETTINGS_FILE  = path.join(app.getPath('userData'), 'settings.json');
const SUPABASE_URL = 'https://sjodltcylcxvauvgabot.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ex94Isy1_u-qzXJWJEqeQg_9nhGkohm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let win;
let tray;
let pollInterval;
let levelPollInterval;
let windowLockInterval;
let gameState = 'idle';
let isCollapsed = false;
let expandedBounds = loadBounds();
let syncRoomId = null;
let syncChannel = null;

const ARAM_QUEUE_IDS = new Set([450]);
const DRAFT_QUEUE_IDS = new Set([400, 420, 430, 440]);

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    if (saved.width && saved.height) return saved;
  } catch {}
  return { width: 320, height: 600, x: null, y: null };
}

function saveBounds() {
  if (isCollapsed) return;
  try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds())); } catch {}
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: expandedBounds.width,
    height: expandedBounds.height,
    x: expandedBounds.x ?? (width - 340),
    y: expandedBounds.y ?? 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.hide();

  win.on('resize', () => {
    if (isCollapsed || applyingHeight) return;
    if (currentNaturalHeight) {
      const [w, h] = win.getSize();
      const targetH = Math.round(currentNaturalHeight * w / NATURAL_WIDTH);
      if (h !== targetH) {
        applyHeight(w, currentNaturalHeight);
      }
    }
    expandedBounds = win.getBounds();
    saveBounds();
  });

  win.on('move', () => {
    if (!isCollapsed) saveBounds();
  });

  win.webContents.once('did-finish-load', () => {
    pollInterval = setInterval(pollGameState, 3000);
    pollGameState();
  });
}

ipcMain.on('quit-app', () => app.quit());
let settingsOpen = false;
ipcMain.on('set-focusable', (_, focusable) => {
  settingsOpen = focusable;
  if (win && !win.isDestroyed()) {
    win.setFocusable(focusable);
    if (focusable) win.focus();
  }
});
ipcMain.on('tray-quit', () => app.quit());
ipcMain.on('tray-toggle-autolaunch', () => applyAutoLaunch(!autoLaunch));

ipcMain.handle('load-settings', () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
});

ipcMain.on('save-settings', (_, settings) => {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {}
});

ipcMain.on('sync-cooldown-event', async (_, payload) => {
  if (!syncRoomId || !payload?.spell || payload.enemyIndex == null) return;
  const match = {
    room_id: syncRoomId,
    enemy_index: payload.enemyIndex,
    spell: payload.spell,
  };

  const { data: existing } = await supabase
    .from('cooldowns')
    .select('id')
    .match(match)
    .order('updated_at', { ascending: false })
    .limit(1);

  const nextValues = payload.action === 'start'
    ? {
        ...match,
        started_at: payload.startedAt,
        duration_ms: payload.durationMs,
        updated_at: new Date().toISOString(),
      }
    : {
        started_at: 0,
        duration_ms: 0,
        updated_at: new Date().toISOString(),
      };

  if (existing?.length) {
    await supabase
      .from('cooldowns')
      .update(nextValues)
      .eq('id', existing[0].id);
    return;
  }

  if (payload.action === 'start') {
    await supabase.from('cooldowns').insert(nextValues);
  }
});

let currentNaturalHeight = null;
let applyingHeight = false;

function applyHeight(w, naturalHeight) {
  const h = Math.round(naturalHeight * w / NATURAL_WIDTH);
  applyingHeight = true;
  win.setSize(w, h);
  applyingHeight = false;
}

let resizeDebounce = null;
ipcMain.on('set-natural-height', (event, naturalHeight) => {
  if (isCollapsed) return;
  currentNaturalHeight = naturalHeight;
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    const [w] = win.getSize();
    applyHeight(w, naturalHeight);
    expandedBounds = { ...win.getBounds() };
    saveBounds();
  }, 50);
});

function toggleCollapse() {
  isCollapsed = !isCollapsed;
  if (isCollapsed) {
    expandedBounds = win.getBounds();
    saveBounds();
    win.setSize(expandedBounds.width, COLLAPSED_HEIGHT);
  } else {
    win.setSize(expandedBounds.width, expandedBounds.height);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('sync-collapse', isCollapsed);
  }
}

ipcMain.on('toggle-collapse', toggleCollapse);

const KEY_MAP = {
  ' ': 'Space',
  'arrowleft': 'Left', 'arrowright': 'Right', 'arrowup': 'Up', 'arrowdown': 'Down',
  'enter': 'Return',
};

function bindToAccelerator(bind) {
  if (!bind) return null;
  const raw = bind.key.toLowerCase();
  const key = KEY_MAP[raw] ?? bind.key.toUpperCase();
  const parts = [];
  if (bind.ctrl)  parts.push('Control');
  if (bind.alt)   parts.push('Alt');
  if (bind.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

let currentCollapseAccelerator = null;

function registerCollapseShortcut(bind) {
  if (currentCollapseAccelerator) {
    globalShortcut.unregister(currentCollapseAccelerator);
    currentCollapseAccelerator = null;
  }
  if (!bind) return;
  const accelerator = bindToAccelerator(bind);
  if (!accelerator) return;
  try {
    const ok = globalShortcut.register(accelerator, toggleCollapse);
    if (ok) currentCollapseAccelerator = accelerator;
  } catch {}
}

ipcMain.on('update-collapse-bind', (_, bind) => registerCollapseShortcut(bind));

app.on('will-quit', () => globalShortcut.unregisterAll());

async function pollGameState() {
  const gameRunning = await isGameRunning();

  if (gameRunning && gameState !== 'in-game') {
    try {
      const [players, gameflowSession, liveGameData] = await Promise.all([
        getAllPlayers(),
        getGameflowSession(),
        getAllGameData().catch(() => null),
      ]);
      const mode = detectGameMode({ gameflowSession, liveGameData });
      const mapped = players.map(p => {
        const ultCds = applyUltItemHaste(getUltCooldowns(p.championName), p.items);
        const spell1 = applySummonerSpellHaste(
          getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellOne)),
          p.items,
          mode
        );
        const spell2 = applySummonerSpellHaste(
          getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellTwo)),
          p.items,
          mode
        );
        return {
        summonerName: p.summonerName,
        riotIdGameName: p.riotIdGameName || '',
        championName: p.championName,
        ddKey: ddKeyFromRaw(p.rawChampionName, p.championName),
        team: p.team,
        spell1,
        spell2,
        ultCds,
        champLevel: p.level ?? 1,
        ultLevel: getUltLevelFromChampLevel(p.level ?? 1),
        };
      });


      let ownTeam = null;
      try {
        const active = await getActivePlayer();
        const activeName = active.summonerName || active.riotId || '';
        const match = mapped.find(p =>
          p.summonerName === activeName ||
          p.riotIdGameName === activeName ||
          p.summonerName.split('#')[0] === activeName ||
          activeName.split('#')[0] === p.summonerName.split('#')[0] ||
          activeName.split('#')[0] === p.riotIdGameName
        );
        ownTeam = match?.team || null;
      } catch {}

      gameState = 'in-game';
      win.showInactive();
      win.webContents.send('game-data', { state: 'in-game', players: mapped, ownTeam, mode });
      await syncToMatchRoom(mapped, ownTeam);
      startLevelPolling(mapped);
      startWindowLock();
    } catch (e) {
    }
    return;
  }

  if (!gameRunning) {
    if (gameState === 'in-game') {
      gameState = 'idle';
      await syncToMatchRoom(null, null);
      win.hide();
      stopLevelPolling();
      stopWindowLock();

      return;
    }

    const clientUp = isClientRunning();

    if (!clientUp && gameState !== 'idle') {
      gameState = 'idle';
      await syncToMatchRoom(null, null);
      win.hide();
      stopLevelPolling();
      stopWindowLock();

      return;
    }

    if (clientUp) {
      try {
        const session = await getChampSelectSession();
        if (session && gameState !== 'champ-select') {
          gameState = 'champ-select';
          win.webContents.send('game-data', {
            state: 'champ-select',
            session,
            mode: detectGameMode({ champSelectSession: session }),
          });
        } else if (!session && gameState === 'champ-select') {
          gameState = 'idle';
          await syncToMatchRoom(null, null);
          win.hide();
          stopLevelPolling();
          stopWindowLock();
    
        }
      } catch {
        if (gameState !== 'idle') {
          gameState = 'idle';
          await syncToMatchRoom(null, null);
          win.hide();
          stopLevelPolling();
          stopWindowLock();
    
        }
      }
    }
  }
}

function startLevelPolling(initialPlayers) {
  stopLevelPolling();
  const lastUltLevel = initialPlayers.map(p => p.ultLevel);
  let lastMode = null;
  const lastCooldownSignature = initialPlayers.map(player => JSON.stringify({
    spell1Cd: player.spell1.cd,
    spell2Cd: player.spell2.cd,
    ultCds: player.ultCds,
  }));

  levelPollInterval = setInterval(async () => {
    try {
      const [players, gameflowSession, liveGameData] = await Promise.all([
        getAllPlayers(),
        getGameflowSession(),
        getAllGameData().catch(() => null),
      ]);
      const mode = detectGameMode({ gameflowSession, liveGameData });
      const updates = [];
      const cooldownUpdates = [];
      players.forEach((p, i) => {
        const ultLevel = getUltLevelFromChampLevel(p.level ?? 1);
        const spell1 = applySummonerSpellHaste(
          getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellOne)),
          p.items,
          mode
        );
        const spell2 = applySummonerSpellHaste(
          getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellTwo)),
          p.items,
          mode
        );
        const ultCds = applyUltItemHaste(getUltCooldowns(p.championName), p.items);
        const signature = JSON.stringify({ spell1Cd: spell1.cd, spell2Cd: spell2.cd, ultCds });
        if (ultLevel !== lastUltLevel[i]) {
          lastUltLevel[i] = ultLevel;
          updates.push({ playerIndex: i, champLevel: p.level ?? 1, ultLevel });
        }
        if (lastMode !== mode || signature !== lastCooldownSignature[i]) {
          lastCooldownSignature[i] = signature;
          cooldownUpdates.push({
            playerIndex: i,
            spell1Cd: spell1.cd,
            spell2Cd: spell2.cd,
            ultCds,
          });
        }
      });
      if (updates.length > 0) win.webContents.send('player-levels', updates);
      if (cooldownUpdates.length > 0) win.webContents.send('player-cooldowns', cooldownUpdates);
      lastMode = mode;
    } catch {}
  }, 5000);
}

function stopLevelPolling() {
  if (levelPollInterval) { clearInterval(levelPollInterval); levelPollInterval = null; }
}

function startWindowLock() {
  stopWindowLock();

  windowLockInterval = setInterval(async () => {
    if (!win || win.isDestroyed() || gameState !== 'in-game') return;
    if (settingsOpen) return;

    const foreground = await getForegroundWindowInfo();
    if (isLeagueGameWindow(foreground)) {
      if (!win.isVisible()) win.showInactive();
      return;
    }

    if (win.isVisible()) win.hide();
  }, 1000);
}

function stopWindowLock() {
  if (windowLockInterval) {
    clearInterval(windowLockInterval);
    windowLockInterval = null;
  }
}

function spellIdFromRaw(spellData) {
  if (!spellData) return 'SummonerFlash';
  const match = spellData.rawDisplayName?.match(/SummonerSpell_(.+?)_DisplayName/);
  return match ? match[1] : 'SummonerFlash';
}

function ddKeyFromRaw(rawChampionName, fallback) {
  const match = rawChampionName?.match(/game_character_displayname_(.+)/);
  if (match) return match[1];
  return (fallback || '').replace(/[' .]/g, '');
}

function firstNumeric(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function normalizeQueueId(session) {
  if (!session) return null;

  return firstNumeric(
    session.queueId,
    session.gameData?.queue?.id,
    session.gameData?.queue?.queueId,
    session.gameData?.queue?.gameQueueConfigId,
    session.gameData?.queue?.queueTypeId,
    session.map?.gameQueueConfigId
  );
}

function normalizeModeText(...values) {
  return values
    .filter(value => typeof value === 'string' && value.trim())
    .join(' ')
    .toLowerCase();
}

function classifyModeFromQueueId(queueId) {
  if (queueId == null) return null;
  if (ARAM_QUEUE_IDS.has(queueId)) return 'aram';
  if (queueId >= 1700 && queueId < 1800) return 'arena';
  if (DRAFT_QUEUE_IDS.has(queueId)) return 'draft';
  return null;
}

function classifyModeFromText(text) {
  if (!text) return null;
  if (text.includes('aram') || text.includes('howling abyss')) return 'aram';
  if (text.includes('arena') || text.includes('cherry')) return 'arena';
  if (text.includes('swiftplay') || text.includes('swift play')) return 'swift';
  if (
    text.includes('draft') ||
    text.includes('ranked') ||
    text.includes('summoner\'s rift') ||
    text.includes('summoners rift')
  ) {
    return 'draft';
  }
  return null;
}

function detectGameMode({ champSelectSession = null, gameflowSession = null, liveGameData = null } = {}) {
  const session = gameflowSession || champSelectSession;
  const queueId = normalizeQueueId(session);
  const fromQueueId = classifyModeFromQueueId(queueId);
  if (fromQueueId) return fromQueueId;

  const sessionText = normalizeModeText(
    session?.phase,
    session?.gameData?.queue?.name,
    session?.gameData?.queue?.shortName,
    session?.gameData?.queue?.description,
    session?.gameData?.queue?.detailedDescription,
    session?.gameData?.queue?.type,
    session?.gameData?.queue?.map?.name,
    session?.map?.name
  );
  const fromSessionText = classifyModeFromText(sessionText);
  if (fromSessionText) return fromSessionText;

  const liveQueueId = firstNumeric(
    liveGameData?.gameData?.queueId,
    liveGameData?.gameData?.gameQueueConfigId,
    liveGameData?.queueId
  );
  const fromLiveQueueId = classifyModeFromQueueId(liveQueueId);
  if (fromLiveQueueId) return fromLiveQueueId;

  const liveText = normalizeModeText(
    liveGameData?.gameData?.gameMode,
    liveGameData?.gameData?.gameType,
    liveGameData?.gameData?.mapName,
    liveGameData?.gameData?.mapTerrain,
    liveGameData?.mapName
  );
  const fromLiveText = classifyModeFromText(liveText);
  if (fromLiveText) return fromLiveText;

  const mapId = firstNumeric(
    liveGameData?.gameData?.mapNumber,
    liveGameData?.gameData?.mapId,
    liveGameData?.gameMap
  );
  if (mapId === 12) return 'aram';

  return 'unknown';
}

function normalizePlayerId(player) {
  return `${player.riotIdGameName || ''}|${player.summonerName || ''}`.trim().toLowerCase();
}

function computeRoomId(players, ownTeam) {
  if (!players || !ownTeam) return null;

  const allies = players
    .filter(player => player.team === ownTeam)
    .map(normalizePlayerId)
    .filter(Boolean)
    .sort();

  if (allies.length !== 5) return null;

  return crypto
    .createHash('sha256')
    .update(allies.join('||'))
    .digest('hex')
    .slice(0, 24);
}

function forwardSyncRow(action, row) {
  if (!row || !win || win.isDestroyed()) return;

  win.webContents.send('sync-cooldown-event', {
    action,
    enemyIndex: row.enemy_index,
    spell: row.spell,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  });
}

async function sendSyncSnapshot(roomId) {
  if (!roomId || !win || win.isDestroyed()) return;

  const { data, error } = await supabase
    .from('cooldowns')
    .select('enemy_index, spell, started_at, duration_ms')
    .eq('room_id', roomId)
    .gt('duration_ms', 0);

  if (error) return;

  win.webContents.send('sync-cooldown-snapshot', data.map(row => ({
    action: 'start',
    enemyIndex: row.enemy_index,
    spell: row.spell,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  })));
}

async function syncToMatchRoom(players, ownTeam) {
  const nextRoomId = computeRoomId(players, ownTeam);
  if (nextRoomId === syncRoomId) return;

  if (syncChannel) {
    await supabase.removeChannel(syncChannel);
    syncChannel = null;
  }

  syncRoomId = nextRoomId;

  if (!syncRoomId) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sync-cooldown-snapshot', []);
    }
    return;
  }

  await sendSyncSnapshot(syncRoomId);

  syncChannel = supabase
    .channel(`cooldowns:${syncRoomId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'cooldowns',
      filter: `room_id=eq.${syncRoomId}`,
    }, payload => forwardSyncRow('start', payload.new))
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'cooldowns',
      filter: `room_id=eq.${syncRoomId}`,
    }, payload => forwardSyncRow(payload.new.duration_ms > 0 ? 'start' : 'cancel', payload.new))
    .subscribe();
}

ipcMain.on('ult-level-changed', (event, { playerIndex, level }) => {
  win.webContents.send('ult-level-update', { playerIndex, level });
});

let autoLaunch = false;
let trayMenu = null;

function applyAutoLaunch(enabled) {
  autoLaunch = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled, name: 'SummTracker' });
}

function openTrayMenu() {
  if (trayMenu && !trayMenu.isDestroyed()) {
    trayMenu.close();
    return;
  }

  const bounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const menuW = 175, menuH = 62;
  let x = Math.round(bounds.x + bounds.width / 2 - menuW / 2);
  let y = bounds.y > display.workArea.height / 2
    ? bounds.y - menuH
    : bounds.y + bounds.height;

  trayMenu = new BrowserWindow({
    width: menuW,
    height: menuH,
    x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  trayMenu.loadFile(path.join(__dirname, '../renderer/tray-menu.html'));
  trayMenu.once('ready-to-show', () => {
    trayMenu.show();
    trayMenu.webContents.send('init', { autoLaunch });
  });
  trayMenu.on('closed', () => { trayMenu = null; });
}

app.whenReady().then(async () => {
  initCooldowns(app.getPath('userData'));
  createWindow();

  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('SummTracker');
  autoLaunch = app.getLoginItemSettings().openAtLogin;
  tray.on('right-click', openTrayMenu);
  tray.on('click', openTrayMenu);
});

app.on('will-quit', () => {
  app.isQuitting = true;
  clearInterval(pollInterval);
  stopLevelPolling();
  stopWindowLock();
  if (syncChannel) supabase.removeChannel(syncChannel);
});

app.on('window-all-closed', () => app.quit());
