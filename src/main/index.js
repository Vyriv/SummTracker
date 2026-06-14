const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { isClientRunning, getChampSelectSession } = require('./lcu');
const { getAllPlayers, isGameRunning, getActivePlayer } = require('./live-game');
const { getSummonerSpell, getUltCooldowns, getUltLevelFromChampLevel, initCooldowns } = require('./cooldowns');

const COLLAPSED_HEIGHT = 32;
const NATURAL_WIDTH = 320;
const BOUNDS_FILE    = path.join(app.getPath('userData'), 'bounds.json');
const SETTINGS_FILE  = path.join(app.getPath('userData'), 'settings.json');

let win;
let tray;
let pollInterval;
let levelPollInterval;
let gameState = 'idle';
let isCollapsed = false;
let expandedBounds = loadBounds();

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
ipcMain.on('tray-quit', () => app.quit());
ipcMain.on('tray-toggle-autolaunch', () => applyAutoLaunch(!autoLaunch));

ipcMain.handle('load-settings', () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
});

ipcMain.on('save-settings', (_, settings) => {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {}
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

ipcMain.on('toggle-collapse', () => {
  isCollapsed = !isCollapsed;
  if (isCollapsed) {
    expandedBounds = win.getBounds();
    saveBounds();
    win.setSize(expandedBounds.width, COLLAPSED_HEIGHT);
  } else {
    win.setSize(expandedBounds.width, expandedBounds.height);
  }
});

async function pollGameState() {
  const gameRunning = await isGameRunning();

  if (gameRunning && gameState !== 'in-game') {
    try {
      const players = await getAllPlayers();
      const mapped = players.map(p => ({
        summonerName: p.summonerName,
        riotIdGameName: p.riotIdGameName || '',
        championName: p.championName,
        ddKey: ddKeyFromRaw(p.rawChampionName, p.championName),
        team: p.team,
        spell1: getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellOne)),
        spell2: getSummonerSpell(spellIdFromRaw(p.summonerSpells?.summonerSpellTwo)),
        ultCds: getUltCooldowns(p.championName),
        champLevel: p.level ?? 1,
        ultLevel: getUltLevelFromChampLevel(p.level ?? 1),
      }));


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
      win.show();
      win.webContents.send('game-data', { state: 'in-game', players: mapped, ownTeam });
      startLevelPolling(mapped);
    } catch (e) {
    }
    return;
  }

  if (!gameRunning) {
    if (gameState === 'in-game') {
      gameState = 'idle';
      win.hide();
      stopLevelPolling();
      return;
    }

    const clientUp = isClientRunning();

    if (!clientUp && gameState !== 'idle') {
      gameState = 'idle';
      win.hide();
      stopLevelPolling();
      return;
    }

    if (clientUp) {
      try {
        const session = await getChampSelectSession();
        if (session && gameState !== 'champ-select') {
          gameState = 'champ-select';
          win.webContents.send('game-data', { state: 'champ-select', session });
        } else if (!session && gameState === 'champ-select') {
          gameState = 'idle';
          win.hide();
          stopLevelPolling();
        }
      } catch {
        if (gameState !== 'idle') {
          gameState = 'idle';
          win.hide();
          stopLevelPolling();
        }
      }
    }
  }
}

function startLevelPolling(initialPlayers) {
  stopLevelPolling();
  const lastUltLevel = initialPlayers.map(p => p.ultLevel);

  levelPollInterval = setInterval(async () => {
    try {
      const players = await getAllPlayers();
      const updates = [];
      players.forEach((p, i) => {
        const ultLevel = getUltLevelFromChampLevel(p.level ?? 1);
        if (ultLevel !== lastUltLevel[i]) {
          lastUltLevel[i] = ultLevel;
          updates.push({ playerIndex: i, champLevel: p.level ?? 1, ultLevel });
        }
      });
      if (updates.length > 0) win.webContents.send('player-levels', updates);
    } catch {}
  }, 5000);
}

function stopLevelPolling() {
  if (levelPollInterval) { clearInterval(levelPollInterval); levelPollInterval = null; }
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

app.whenReady().then(() => {
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
});

app.on('window-all-closed', () => app.quit());
