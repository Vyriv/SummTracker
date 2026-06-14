# SummTracker

A lightweight Windows overlay for League of Legends that tracks summoner spell and ultimate cooldowns for all 10 players in real time.

![SummTracker overlay](assets/preview.png)

## Features

- Automatically appears when a game starts, hides when it ends
- Shows summoner spells and ultimate for every player, split by ally / enemy team
- Click any spell to start its cooldown timer — click again to reset
- Ult level pips update automatically as players level up
- Resizable and repositionable — position saves between sessions
- Cooldown data fetched from DDragon and cached locally, updates automatically each patch

## Installation

Download and run **SummTracker Setup.exe** from the [latest release](https://github.com/Vyriv/SummTracker/releases/latest).

No configuration needed. The overlay starts tracking as soon as you load into a game.

## How it works

SummTracker polls the [League Live Game Data API](https://developer.riotgames.com/docs/lol#game-client-api) that runs locally on your machine during a game. No Riot API key is required, everything is read from the local client.

Cooldown values are sourced from DDragon on first launch and cached until the next patch.

## Requirements

- Windows 10 / 11
- League of Legends installed and running

## Building from source

```bash
npm install
npm start        # run in dev
npm run dist     # build installer
```
