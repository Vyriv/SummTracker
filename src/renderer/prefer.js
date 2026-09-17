import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const DEFAULT_SETTINGS = {
  preferList: [],
};

let settings = { ...DEFAULT_SETTINGS };
let champions = [];
let DDragon = 'https://ddragon.leagueoflegends.com/cdn/14.24.1';

function iconUrl(id) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${id}.png`;
}

function savePreferList() {
  settings.preferList = Array.isArray(settings.preferList) ? settings.preferList : [];
  invoke('load_settings')
    .catch(() => ({}))
    .then(latest => {
      const next = { ...latest, preferList: settings.preferList };
      settings = { ...settings, ...next };
      return invoke('save_settings', { settings: next });
    })
    .catch(() => {});
}

function normalizePreferList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const id = Number(entry?.id ?? entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = entry?.name || champions.find(c => c.key === id)?.name || `Champ ${id}`;
    out.push({ id, name });
  }
  return out;
}

function renderList() {
  const listEl = document.getElementById('prefer-list');
  const emptyEl = document.getElementById('prefer-empty');
  const list = settings.preferList;
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
    img.src = iconUrl(entry.id);
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
    up.addEventListener('click', () => moveEntry(index, -1));

    const down = document.createElement('button');
    down.type = 'button';
    down.title = 'Move down';
    down.textContent = '▼';
    down.disabled = index === list.length - 1;
    down.addEventListener('click', () => moveEntry(index, 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'prefer-remove';
    remove.title = 'Remove';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      settings.preferList = settings.preferList.filter((_, i) => i !== index);
      savePreferList();
      renderList();
      renderSuggestions(document.getElementById('prefer-search').value);
    });

    actions.append(up, down, remove);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

function moveEntry(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= settings.preferList.length) return;
  const list = settings.preferList.slice();
  const [item] = list.splice(index, 1);
  list.splice(next, 0, item);
  settings.preferList = list;
  savePreferList();
  renderList();
}

function addChampion(champ) {
  if (!champ?.key) return;
  if (settings.preferList.some(e => e.id === champ.key)) return;
  settings.preferList = [...settings.preferList, { id: champ.key, name: champ.name }];
  savePreferList();
  renderList();
  const search = document.getElementById('prefer-search');
  search.value = '';
  renderSuggestions('');
  search.focus();
}

function renderSuggestions(query) {
  const box = document.getElementById('prefer-suggestions');
  box.innerHTML = '';
  const q = String(query || '').trim().toLowerCase();
  if (!q) return;

  const selected = new Set(settings.preferList.map(e => e.id));
  const matches = champions
    .filter(c => !selected.has(c.key) && c.name.toLowerCase().includes(q))
    .slice(0, 12);

  matches.forEach(champ => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prefer-suggest';
    const img = document.createElement('img');
    img.src = iconUrl(champ.key);
    img.alt = champ.name;
    const label = document.createElement('span');
    label.textContent = champ.name;
    btn.append(img, label);
    btn.addEventListener('click', () => addChampion(champ));
    box.appendChild(btn);
  });
}

async function loadChampions() {
  try {
    const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json());
    DDragon = `https://ddragon.leagueoflegends.com/cdn/${versions[0]}`;
    const data = await fetch(`${DDragon}/data/en_US/champion.json`).then(r => r.json());
    champions = Object.values(data.data || {})
      .map(champ => ({ key: Number(champ.key), name: champ.name, id: champ.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {
    champions = [];
  }
}

document.getElementById('prefer-search').addEventListener('input', e => {
  renderSuggestions(e.target.value);
});

document.getElementById('prefer-search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const first = document.querySelector('.prefer-suggest');
  if (first) first.click();
});

document.getElementById('close-btn').addEventListener('click', () => {
  getCurrentWindow().close();
});

document.getElementById('titlebar').addEventListener('mousedown', e => {
  if (e.target.closest('button')) return;
  getCurrentWindow().startDragging().catch(() => {});
});

invoke('load_settings').then(async saved => {
  settings = { ...DEFAULT_SETTINGS, ...saved };
  await loadChampions();
  settings.preferList = normalizePreferList(settings.preferList);
  renderList();
}).catch(async () => {
  await loadChampions();
  renderList();
});
