const fs = require('fs');
const fetch = require('node-fetch');

const DDRAGON_VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';

// Base cooldowns in seconds
const SUMMONER_SPELLS = {
  SummonerFlash:     { name: 'Flash',     cd: 300, icon: 'SummonerFlash' },
  SummonerIgnite:    { name: 'Ignite',    cd: 180, icon: 'SummonerDot' },
  SummonerExhaust:   { name: 'Exhaust',   cd: 210, icon: 'SummonerExhaust' },
  SummonerHeal:      { name: 'Heal',      cd: 240, icon: 'SummonerHeal' },
  SummonerBarrier:   { name: 'Barrier',   cd: 180, icon: 'SummonerBarrier' },
  SummonerBoost:     { name: 'Cleanse',   cd: 210, icon: 'SummonerBoost' },
  SummonerHaste:     { name: 'Ghost',     cd: 210, icon: 'SummonerHaste' },
  SummonerTeleport:  { name: 'Teleport',  cd: 360, icon: 'SummonerTeleport' },
  SummonerSmite:                  { name: 'Smite',    cd: 15,  icon: 'SummonerSmite' },
  S5_SummonerSmitePlayerGanker:   { name: 'Smite',   cd: 15,  icon: 'S5_SummonerSmitePlayerGanker' },
  SummonerSmiteAvatarOffensive:   { name: 'Smite',   cd: 15,  icon: 'SummonerSmiteAvatarOffensive' },
  SummonerSmiteAvatarDefensive:   { name: 'Smite',   cd: 15,  icon: 'SummonerSmiteAvatarDefensive' },
  SummonerSmiteAvatarUtility:     { name: 'Smite',   cd: 15,  icon: 'SummonerSmiteAvatarUtility' },
  SummonerMana:                   { name: 'Clarity', cd: 240, icon: 'SummonerMana' },
  SummonerDot:                    { name: 'Ignite',  cd: 180, icon: 'SummonerDot' },
  SummonerSnowball:               { name: 'Mark',    cd: 80,  icon: 'SummonerSnowball' },
  SummonerTeleportUpgrade:        { name: 'Teleport', cd: 240, icon: 'SummonerTeleportUpgrade' },
  S12_SummonerTeleportUpgrade:    { name: 'Teleport', cd: 240, icon: 'SummonerTeleportUpgrade' },
  SummonerNoviceTeleport:         { name: 'Teleport', cd: 360, icon: 'SummonerTeleport' },
};

// Ultimate cooldowns [R1, R2, R3] in seconds — sourced from DDragon 16.12.1
const ULT_COOLDOWNS = {
  Aatrox:          [120, 100, 80],
  Ahri:            [140, 120, 100],
  Akali:           [120, 90, 60],
  Akshan:          [100, 85, 70],
  Alistar:         [120, 100, 80],
  Ambessa:         [130, 115, 100],
  Amumu:           [150, 125, 100],
  Anivia:          [4, 3, 2],
  Annie:           [130, 115, 100],
  Aphelios:        [120, 110, 100],
  Ashe:            [100, 80, 60],
  AurelionSol:     [120, 110, 100],
  Aurora:          [140, 120, 100],
  Azir:            [120, 105, 90],
  Bard:            [110, 95, 80],
  Belveth:         [1, 1, 1],
  Blitzcrank:      [60, 40, 20],
  Brand:           [100, 90, 80],
  Braum:           [130, 115, 100],
  Briar:           [120, 100, 80],
  Caitlyn:         [90, 90, 90],
  Camille:         [140, 115, 90],
  Cassiopeia:      [120, 100, 80],
  Chogath:         [80, 70, 60],
  Corki:           [2, 2, 2],
  Darius:          [120, 100, 80],
  Diana:           [100, 90, 80],
  DrMundo:         [120, 120, 120],
  Draven:          [100, 90, 80],
  Ekko:            [110, 80, 50],
  Elise:           [3, 3, 3],
  Evelynn:         [120, 100, 80],
  Ezreal:          [120, 105, 90],
  Fiddlesticks:    [140, 110, 80],
  Fiora:           [110, 90, 70],
  Fizz:            [120, 100, 80],
  Galio:           [180, 160, 140],
  Gangplank:       [160, 140, 120],
  Garen:           [120, 100, 80],
  Gnar:            [90, 60, 30],
  Gragas:          [100, 85, 70],
  Graves:          [100, 80, 60],
  Gwen:            [120, 100, 80],
  Hecarim:         [140, 120, 100],
  Heimerdinger:    [100, 85, 70],
  Hwei:            [120, 100, 80],
  Illaoi:          [120, 95, 70],
  Irelia:          [125, 105, 85],
  Ivern:           [140, 130, 120],
  Janna:           [130, 115, 100],
  JarvanIV:        [120, 105, 90],
  Jax:             [110, 100, 90],
  Jayce:           [6, 6, 6],
  Jhin:            [120, 105, 90],
  Jinx:            [85, 65, 45],
  KSante:          [120, 100, 80],
  Kaisa:           [130, 100, 70],
  Kalista:         [160, 140, 120],
  Karma:           [40, 38, 36],
  Karthus:         [200, 180, 160],
  Kassadin:        [5, 3.5, 2],
  Katarina:        [75, 60, 45],
  Kayle:           [160, 120, 80],
  Kayn:            [120, 100, 80],
  Kennen:          [120, 120, 120],
  Khazix:          [100, 85, 70],
  Kindred:         [160, 140, 120],
  Kled:            [140, 125, 110],
  KogMaw:          [2, 1.5, 1],
  Leblanc:         [45, 35, 25],
  LeeSin:          [110, 85, 60],
  Leona:           [90, 75, 60],
  Lillia:          [150, 130, 110],
  Lissandra:       [120, 100, 80],
  Lucian:          [110, 100, 90],
  Lulu:            [120, 100, 80],
  Lux:             [60, 50, 40],
  Malphite:        [130, 115, 100],
  Malzahar:        [140, 110, 80],
  Maokai:          [130, 110, 90],
  MasterYi:        [85, 85, 85],
  Mel:             [120, 100, 80],
  Milio:           [160, 145, 130],
  MissFortune:     [120, 110, 100],
  MonkeyKing:      [130, 110, 90],
  Mordekaiser:     [140, 120, 100],
  Morgana:         [120, 110, 100],
  Naafiri:         [110, 95, 80],
  Nami:            [120, 110, 100],
  Nasus:           [120, 100, 80],
  Nautilus:        [120, 100, 80],
  Neeko:           [120, 105, 90],
  Nidalee:         [3, 3, 3],
  Nilah:           [110, 95, 80],
  Nocturne:        [140, 115, 90],
  Nunu:            [110, 100, 90],
  Olaf:            [100, 90, 80],
  Orianna:         [110, 95, 80],
  Ornn:            [140, 120, 100],
  Pantheon:        [180, 165, 150],
  Poppy:           [140, 120, 100],
  Pyke:            [100, 85, 70],
  Qiyana:          [120, 120, 120],
  Quinn:           [3, 3, 3],
  Rakan:           [130, 110, 90],
  Rammus:          [120, 105, 90],
  RekSai:          [120, 100, 80],
  Rell:            [120, 100, 80],
  Renata:          [150, 130, 110],
  Renekton:        [120, 100, 80],
  Rengar:          [100, 90, 80],
  Riven:           [120, 90, 60],
  Rumble:          [130, 105, 80],
  Ryze:            [180, 160, 140],
  Samira:          [5, 5, 5],
  Sejuani:         [120, 105, 90],
  Senna:           [140, 120, 100],
  Seraphine:       [160, 140, 120],
  Sett:            [120, 100, 80],
  Shaco:           [100, 90, 80],
  Shen:            [200, 180, 160],
  Shyvana:         [0, 0, 0],
  Singed:          [100, 100, 100],
  Sion:            [140, 100, 60],
  Sivir:           [120, 100, 80],
  Skarner:         [120, 105, 90],
  Smolder:         [120, 110, 100],
  Sona:            [140, 120, 100],
  Soraka:          [150, 135, 120],
  Swain:           [120, 120, 120],
  Sylas:           [80, 55, 30],
  Syndra:          [120, 100, 80],
  TahmKench:       [0, 0, 0],
  Taliyah:         [180, 150, 120],
  Talon:           [100, 80, 60],
  Taric:           [180, 150, 120],
  Teemo:           [0.25, 0.25, 0.25],
  Thresh:          [120, 100, 80],
  Tristana:        [100, 100, 100],
  Trundle:         [120, 100, 80],
  Tryndamere:      [120, 100, 80],
  TwistedFate:     [170, 140, 110],
  Twitch:          [90, 90, 90],
  Udyr:            [6, 6, 6],
  Urgot:           [100, 85, 70],
  Varus:           [100, 80, 60],
  Vayne:           [100, 85, 70],
  Veigar:          [120, 90, 60],
  Velkoz:          [100, 90, 80],
  Vex:             [140, 120, 100],
  Vi:              [140, 115, 90],
  Viego:           [120, 100, 80],
  Viktor:          [120, 100, 80],
  Vladimir:        [120, 120, 120],
  Volibear:        [160, 135, 110],
  Warwick:         [110, 90, 70],
  Xayah:           [140, 120, 100],
  Xerath:          [130, 115, 100],
  XinZhao:         [120, 110, 100],
  Yasuo:           [70, 50, 30],
  Yone:            [120, 100, 80],
  Yorick:          [160, 130, 100],
  Yunara:          [100, 90, 80],
  Yuumi:           [120, 110, 100],
  Zaahen:          [110, 95, 80],
  Zac:             [120, 105, 90],
  Zed:             [120, 110, 100],
  Zeri:            [80, 75, 70],
  Ziggs:           [120, 95, 70],
  Zilean:          [120, 90, 60],
  Zoe:             [11, 8, 5],
  Zyra:            [110, 100, 90],
};

function getUltCooldown(championName, level = 1) {
  const cds = ULT_COOLDOWNS[championName];
  if (!cds) return 120;
  return cds[Math.min(level - 1, 2)] || 120;
}

function getUltCooldowns(championName) {
  const cds = ULT_COOLDOWNS[championName];
  if (!cds) return [120, 100, 80];
  return cds;
}

// Standard ult unlock thresholds: 6 → R1, 11 → R2, 16 → R3
function getUltLevelFromChampLevel(champLevel) {
  if (champLevel >= 16) return 3;
  if (champLevel >= 11) return 2;
  if (champLevel >= 6)  return 1;
  return 0;
}

function getSummonerSpell(spellId) {
  return SUMMONER_SPELLS[spellId] || { name: spellId, cd: 300, icon: spellId };
}

async function initCooldowns(userDataPath) {
  const cachePath = `${userDataPath}/ult-cache.json`;
  try {
    const versionsRes = await fetch(DDRAGON_VERSIONS_URL, { timeout: 5000 });
    const versions = await versionsRes.json();
    const latest = versions[0];

    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}

    if (cached?.version === latest) {
      Object.assign(ULT_COOLDOWNS, cached.cooldowns);
      return;
    }

    const dataRes = await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/championFull.json`,
      { timeout: 30000 }
    );
    const data = await dataRes.json();

    const cooldowns = {};
    for (const [key, champ] of Object.entries(data.data)) {
      const cds = champ.spells[3].cooldown.slice(0, 3);
      while (cds.length < 3) cds.push(cds[cds.length - 1]);
      cooldowns[key] = cds;
    }

    Object.assign(ULT_COOLDOWNS, cooldowns);
    fs.writeFileSync(cachePath, JSON.stringify({ version: latest, cooldowns }));
  } catch {}
}

module.exports = { getSummonerSpell, getUltCooldown, getUltCooldowns, getUltLevelFromChampLevel, initCooldowns, SUMMONER_SPELLS, ULT_COOLDOWNS };
