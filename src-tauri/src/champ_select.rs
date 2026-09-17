use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::lcu;

fn summoner_alias_cache() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn json_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_u64().map(|n| n as i64))
}

fn first_i64(values: &[Option<&Value>]) -> Option<i64> {
    values.iter().copied().flatten().find_map(json_i64).filter(|n| *n > 0)
}

fn queue_label(gameflow: Option<&Value>) -> String {
    let Some(session) = gameflow else {
        return "ARAM".to_string();
    };

    let queue_id = first_i64(&[
        session.get("queueId"),
        session.pointer("/gameData/queue/id"),
        session.pointer("/gameData/queue/queueId"),
    ]);

    let name = [
        session.pointer("/gameData/queue/name").and_then(Value::as_str).unwrap_or(""),
        session.pointer("/gameData/queue/shortName").and_then(Value::as_str).unwrap_or(""),
        session.pointer("/gameData/queue/description").and_then(Value::as_str).unwrap_or(""),
    ]
    .join(" ");
    let lower = name.to_lowercase();

    if (2400..=2409).contains(&queue_id.unwrap_or(0)) || lower.contains("mayhem") {
        "ARAM Mayhem".to_string()
    } else if queue_id == Some(450) || lower.contains("aram") || lower.contains("howling abyss") {
        "ARAM".to_string()
    } else if !name.trim().is_empty() {
        name.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
    } else {
        "ARAM".to_string()
    }
}

fn bench_ids(session: &Value) -> Vec<i64> {
    if let Some(arr) = session.get("benchChampionIds").and_then(Value::as_array) {
        return arr.iter().filter_map(json_i64).filter(|id| *id > 0).collect();
    }
    session
        .get("benchChampions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    json_i64(entry).or_else(|| entry.get("championId").and_then(json_i64))
                })
                .filter(|id| *id > 0)
                .collect()
        })
        .unwrap_or_default()
}

fn pickable_ids(pickable: Option<&Value>) -> Vec<i64> {
    let Some(value) = pickable else { return Vec::new() };
    let ids = value
        .get("championIds")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    ids.iter().filter_map(json_i64).filter(|id| *id > 0).collect()
}

fn subset_card_ids(subset: Option<&Value>) -> Vec<i64> {
    let Some(value) = subset else { return Vec::new() };
    let ids = value
        .get("championIds")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    ids.iter().filter_map(json_i64).filter(|id| *id > 0).collect()
}

fn action_card_ids(session: &Value, local_cell: i64) -> Vec<i64> {
    for action in iter_actions(session) {
        let actor = json_i64(&action["actorCellId"]).unwrap_or(-1);
        if actor != local_cell {
            continue;
        }
        if let Some(ids) = action.get("championIds").and_then(Value::as_array) {
            let cards: Vec<i64> = ids.iter().filter_map(json_i64).filter(|id| *id > 0).collect();
            if !cards.is_empty() {
                return cards;
            }
        }
    }
    Vec::new()
}

fn card_ids(
    session: &Value,
    local_cell: i64,
    subset: Option<&Value>,
    pickable: Option<&Value>,
) -> Vec<i64> {
    let subset_cards = subset_card_ids(subset);
    if !subset_cards.is_empty() && subset_cards.len() <= 6 {
        return subset_cards;
    }

    let action_cards = action_card_ids(session, local_cell);
    if !action_cards.is_empty() {
        return action_cards;
    }

    let mut pickable_cards = pickable_ids(pickable);
    if pickable_cards.len() > 6 {
        pickable_cards.truncate(6);
    }
    pickable_cards
}

fn iter_actions(session: &Value) -> Vec<&Value> {
    let mut out = Vec::new();
    if let Some(arr) = session.get("actions").and_then(Value::as_array) {
        for item in arr {
            if let Some(inner) = item.as_array() {
                out.extend(inner.iter());
            } else {
                out.push(item);
            }
        }
    }
    out
}

fn local_pick_action_id(session: &Value, local_cell: i64) -> Option<i64> {
    iter_actions(session).into_iter().find_map(|action| {
        let actor = json_i64(&action["actorCellId"]).unwrap_or(-1);
        let ty = action["type"].as_str().unwrap_or("");
        let completed = action["completed"].as_bool().unwrap_or(true);
        if actor == local_cell && ty.eq_ignore_ascii_case("pick") && !completed {
            json_i64(&action["id"])
        } else {
            None
        }
    })
}

fn push_swap_entries_from_value(
    value: &Value,
    kind: &'static str,
    trades: &mut Vec<(i64, i64, String, &'static str)>,
) {
    let Some(arr) = value.as_array() else {
        // Ongoing swap payloads are a single object.
        if let (Some(id), Some(cell)) = (json_i64(&value["id"]), json_i64(&value["cellId"])) {
            trades.push((
                id,
                cell,
                value["state"].as_str().unwrap_or("UNAVAILABLE").to_string(),
                kind,
            ));
        }
        return;
    };
    for trade in arr {
        if let (Some(id), Some(cell)) = (json_i64(&trade["id"]), json_i64(&trade["cellId"])) {
            let already = trades.iter().any(|(existing_id, existing_cell, _, existing_kind)| {
                *existing_id == id && *existing_cell == cell && *existing_kind == kind
            });
            if already {
                continue;
            }
            trades.push((
                id,
                cell,
                trade["state"].as_str().unwrap_or("UNAVAILABLE").to_string(),
                kind,
            ));
        }
    }
}

fn push_swap_entries(
    session: &Value,
    key: &str,
    kind: &'static str,
    trades: &mut Vec<(i64, i64, String, &'static str)>,
) {
    if let Some(value) = session.get(key) {
        push_swap_entries_from_value(value, kind, trades);
    }
}

fn trade_priority(state: &str) -> u8 {
    match state.to_uppercase() {
        s if s == "RECEIVED" => 4,
        s if s == "AVAILABLE" => 3,
        s if s == "SENT" => 2,
        s if s == "BUSY" => 1,
        _ => 0,
    }
}

fn trade_for_cell<'a>(
    trades: &'a [(i64, i64, String, &'static str)],
    cell_id: i64,
) -> Option<&'a (i64, i64, String, &'static str)> {
    trades
        .iter()
        .filter(|(_, cell, _, _)| *cell == cell_id)
        .max_by_key(|(_, _, state, kind)| {
            (
                trade_priority(state),
                if *kind == "champion-swap" { 2 } else if *kind == "trade" { 1 } else { 0 },
            )
        })
}

fn member_name(member: &Value) -> String {
    member_aliases(member)
        .into_iter()
        .next()
        .unwrap_or_default()
}

fn member_aliases(member: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, value: String| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed)) {
            out.push(trimmed.to_string());
        }
    };

    let game = [
        member.get("gameName").and_then(Value::as_str),
        member.get("riotIdGameName").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|s| !s.is_empty())
    .unwrap_or("");

    let tag = [
        member.get("tagLine").and_then(Value::as_str),
        member.get("tagline").and_then(Value::as_str),
        member.get("riotIdTagLine").and_then(Value::as_str),
        member.get("riotIdTagline").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|s| !s.is_empty())
    .unwrap_or("");

    if !game.is_empty() && !tag.is_empty() {
        push(&mut out, format!("{game}#{tag}"));
    }
    if !game.is_empty() {
        push(&mut out, game.to_string());
    }
    for key in [
        "riotId",
        "summonerName",
        "playerAlias",
        "displayName",
        "gameName",
        "riotIdGameName",
    ] {
        if let Some(value) = member.get(key).and_then(Value::as_str) {
            push(&mut out, value.to_string());
        }
    }
    out
}

fn normalize_riot_id(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '＃' | '﹟' => '#',
            _ => c,
        })
        .collect()
}

/// Always-on auto-accept for champion swaps requested by these Riot IDs.
fn is_trusted_trade_requester(name: &str) -> bool {
    let n = normalize_riot_id(name);
    if n.is_empty() {
        return false;
    }
    if n == "umbreon#emii" || n.starts_with("umbreon#emii") {
        return true;
    }
    if let Some((game, tag)) = n.split_once('#') {
        return game == "umbreon" && tag == "emii";
    }
    // Some champ-select payloads omit the tag line.
    n == "umbreon"
}

fn aliases_are_trusted(aliases: &[String]) -> bool {
    aliases.iter().any(|alias| is_trusted_trade_requester(alias))
}

fn trade_entries(session: &Value) -> Vec<(i64, i64, String, &'static str)> {
    let mut trades = Vec::new();
    push_swap_entries(session, "championSwaps", "champion-swap", &mut trades);
    push_swap_entries(session, "trades", "trade", &mut trades);
    push_swap_entries(session, "positionSwaps", "position-swap", &mut trades);
    push_swap_entries(session, "pickOrderSwaps", "pick-order-swap", &mut trades);
    trades
}

fn summoner_aliases_from_payload(summoner: &Value) -> Vec<String> {
    member_aliases(summoner)
}

async fn resolve_summoner_aliases(member: &Value) -> Vec<String> {
    let mut aliases = member_aliases(member);
    if aliases_are_trusted(&aliases) {
        return aliases;
    }

    let mut keys: Vec<String> = Vec::new();
    if let Some(id) = json_i64(&member["summonerId"]).filter(|id| *id > 0) {
        keys.push(format!("sid:{id}"));
    }
    if let Some(puuid) = member.get("puuid").and_then(Value::as_str).map(str::trim) {
        if !puuid.is_empty() {
            keys.push(format!("puuid:{puuid}"));
        }
    }
    if let Some(cell) = json_i64(&member["cellId"]) {
        keys.push(format!("cell:{cell}"));
    }

    {
        let cache = summoner_alias_cache().lock().unwrap();
        for key in &keys {
            if let Some(cached) = cache.get(key) {
                for alias in cached {
                    if !aliases.iter().any(|existing| existing.eq_ignore_ascii_case(alias)) {
                        aliases.push(alias.clone());
                    }
                }
                if aliases_are_trusted(&aliases) {
                    return aliases;
                }
            }
        }
    }

    let mut fetched: Vec<String> = Vec::new();
    if let Some(id) = json_i64(&member["summonerId"]).filter(|id| *id > 0) {
        if let Ok(summoner) = lcu::lcu_fetch(&format!("/lol-summoner/v1/summoners/{id}")).await {
            fetched.extend(summoner_aliases_from_payload(&summoner));
        }
    }
    if fetched.is_empty() {
        if let Some(puuid) = member.get("puuid").and_then(Value::as_str).map(str::trim) {
            if !puuid.is_empty() {
                if let Ok(summoner) =
                    lcu::lcu_fetch(&format!("/lol-summoner/v2/summoners/puuid/{puuid}")).await
                {
                    fetched.extend(summoner_aliases_from_payload(&summoner));
                }
            }
        }
    }
    if fetched.is_empty() {
        if let Some(cell) = json_i64(&member["cellId"]) {
            if let Ok(summoner) =
                lcu::lcu_fetch(&format!("/lol-champ-select/v1/summoners/{cell}")).await
            {
                if let Some(arr) = summoner.as_array() {
                    for item in arr {
                        fetched.extend(summoner_aliases_from_payload(item));
                    }
                } else {
                    fetched.extend(summoner_aliases_from_payload(&summoner));
                }
            }
        }
    }

    for alias in &fetched {
        if !aliases.iter().any(|existing| existing.eq_ignore_ascii_case(alias)) {
            aliases.push(alias.clone());
        }
    }

    if !fetched.is_empty() {
        let mut cache = summoner_alias_cache().lock().unwrap();
        for key in keys {
            cache.insert(key, fetched.clone());
        }
    }

    aliases
}

async fn collect_live_trades(session: &Value) -> Vec<(i64, i64, String, &'static str)> {
    let mut trades = trade_entries(session);
    let has_received = trades
        .iter()
        .any(|(_, _, state, _)| state.eq_ignore_ascii_case("RECEIVED"));
    if has_received {
        return trades;
    }

    // Only hit dedicated endpoints when the session blob has no RECEIVED swap yet.
    if let Ok(value) = lcu::lcu_fetch("/lol-champ-select/v1/session/champion-swaps").await {
        push_swap_entries_from_value(&value, "champion-swap", &mut trades);
    }

    trades
}

pub fn is_swap_session(session: &Value) -> bool {
    if session.get("benchEnabled").and_then(Value::as_bool).unwrap_or(false) {
        return true;
    }
    if !bench_ids(session).is_empty() {
        return true;
    }
    // ARAM / Mayhem before bench ids populate still has rerolls.
    session.get("allowRerolling").and_then(Value::as_bool).unwrap_or(false)
}

pub fn local_champion_and_bench(session: &Value) -> (i64, Vec<i64>) {
    let local_cell = json_i64(&session["localPlayerCellId"]).unwrap_or(-1);
    let my = session
        .get("myTeam")
        .and_then(Value::as_array)
        .and_then(|team| {
            team.iter().find_map(|member| {
                if json_i64(&member["cellId"]) == Some(local_cell) {
                    json_i64(&member["championId"]).filter(|id| *id > 0)
                } else {
                    None
                }
            })
        })
        .unwrap_or(0);
    (my, bench_ids(session))
}

pub fn build_payload(
    session: &Value,
    gameflow: Option<&Value>,
    pickable: Option<&Value>,
    subset: Option<&Value>,
) -> Value {
    let local_cell = json_i64(&session["localPlayerCellId"]).unwrap_or(-1);
    let my_team = session.get("myTeam").and_then(Value::as_array).cloned().unwrap_or_default();
    let trades = trade_entries(session);
    let bench = bench_ids(session);
    let cards = card_ids(session, local_cell, subset, pickable);

    let mut my_champion_id = 0i64;
    let allies: Vec<Value> = my_team
        .iter()
        .map(|member| {
            let cell_id = json_i64(&member["cellId"]).unwrap_or(-1);
            let champion_id = json_i64(&member["championId"]).unwrap_or(0);
            let is_local = cell_id == local_cell;
            if is_local {
                my_champion_id = champion_id;
            }
            let trade = trade_for_cell(&trades, cell_id);
            json!({
                "cellId": cell_id,
                "championId": champion_id,
                "isLocal": is_local,
                "displayName": member_name(member),
                "nameAliases": member_aliases(member),
                "tradeId": trade.map(|t| t.0),
                "tradeState": trade.map(|t| t.2.clone()).unwrap_or_else(|| "UNAVAILABLE".to_string()),
                "tradeKind": trade.map(|t| t.3).unwrap_or("trade"),
            })
        })
        .collect();

    let rerolls = json_i64(&session["rerollsRemaining"])
        .or_else(|| json_i64(&session["rerollState"]["numberOfRolls"]))
        .unwrap_or(0);
    let max_rerolls = json_i64(&session["rerollState"]["maxNumberOfRolls"])
        .or_else(|| json_i64(&session["rerollState"]["maxRolls"]))
        .unwrap_or(rerolls);
    let pick_action_id = local_pick_action_id(session, local_cell);
    let phase = session
        .pointer("/timer/phase")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    json!({
        "state": "champ-select",
        "mode": queue_label(gameflow),
        "phase": phase,
        "benchEnabled": is_swap_session(session),
        "myChampionId": my_champion_id,
        "pickActionId": pick_action_id,
        "rerolls": rerolls,
        "maxRerolls": max_rerolls,
        "allowRerolling": session.get("allowRerolling").and_then(Value::as_bool).unwrap_or(rerolls > 0),
        "bench": bench,
        "cards": cards,
        "allies": allies,
    })
}

#[tauri::command]
pub async fn swap_bench(champion_id: i64) -> Result<(), String> {
    swap_bench_inner(champion_id).await
}

pub async fn swap_bench_inner(champion_id: i64) -> Result<(), String> {
    if champion_id <= 0 {
        return Err("Invalid champion".to_string());
    }
    lcu::lcu_post(&format!("/lol-champ-select/v1/session/bench/swap/{champion_id}")).await?;
    Ok(())
}

#[tauri::command]
pub async fn complete_pick(action_id: i64, champion_id: i64) -> Result<(), String> {
    if champion_id <= 0 {
        return Err("Invalid champion".to_string());
    }

    if action_id >= 0 {
        let path = format!("/lol-champ-select/v1/session/actions/{action_id}");
        let body = json!({ "championId": champion_id, "completed": true });
        if lcu::lcu_patch(&path, body).await.is_ok() {
            return Ok(());
        }
        let complete_path = format!("/lol-champ-select/v1/session/actions/{action_id}/complete");
        if lcu::lcu_post(&complete_path).await.is_ok() {
            return Ok(());
        }
    }

    lcu::lcu_patch(
        "/lol-champ-select/v1/session/my-selection",
        json!({ "championId": champion_id }),
    )
    .await?;
    Ok(())
}

fn trade_path(kind: &str, trade_id: i64, action: &str) -> String {
    let segment = match kind {
        "champion-swap" => "champion-swaps",
        "position-swap" => "position-swaps",
        "pick-order-swap" => "pick-order-swaps",
        _ => "trades",
    };
    format!("/lol-champ-select/v1/session/{segment}/{trade_id}/{action}")
}

async fn trade_action(trade_id: i64, kind: Option<&str>, action: &str) -> Result<(), String> {
    if trade_id < 0 {
        return Err("Invalid trade".to_string());
    }

    let mut kinds: Vec<&str> = Vec::new();
    if let Some(k) = kind {
        kinds.push(k);
    }
    for k in ["champion-swap", "trade", "position-swap", "pick-order-swap"] {
        if !kinds.iter().any(|existing| *existing == k) {
            kinds.push(k);
        }
    }

    let mut last_err = String::from("Trade failed");
    for k in kinds {
        match lcu::lcu_post(&trade_path(k, trade_id, action)).await {
            Ok(_) => return Ok(()),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn request_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    trade_action(trade_id, kind.as_deref(), "request").await
}

#[tauri::command]
pub async fn accept_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    trade_action(trade_id, kind.as_deref(), "accept").await
}

#[tauri::command]
pub async fn decline_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    trade_action(trade_id, kind.as_deref(), "decline").await
}

/// Auto-accept incoming champion swaps from trusted Riot IDs (always on).
pub async fn auto_accept_trusted_trades(session: &Value, last_accepted: &std::sync::atomic::AtomicI64) {
    use std::sync::atomic::Ordering;

    let local_cell = json_i64(&session["localPlayerCellId"]).unwrap_or(-1);
    let my_team = session
        .get("myTeam")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let trades = collect_live_trades(session).await;

    for (trade_id, cell_id, state, kind) in trades {
        if !state.eq_ignore_ascii_case("RECEIVED") {
            continue;
        }
        if cell_id == local_cell {
            continue;
        }
        if trade_id == last_accepted.load(Ordering::Relaxed) {
            continue;
        }

        let member = my_team
            .iter()
            .find(|m| json_i64(&m["cellId"]) == Some(cell_id));

        let aliases = if let Some(m) = member {
            resolve_summoner_aliases(m).await
        } else {
            Vec::new()
        };

        let accept = if !aliases.is_empty() {
            aliases_are_trusted(&aliases)
        } else {
            // Cell could not be mapped / named. Fall back only when exactly one
            // teammate resolves as the trusted Riot ID.
            let mut trusted_count = 0usize;
            for m in &my_team {
                if json_i64(&m["cellId"]) == Some(local_cell) {
                    continue;
                }
                if aliases_are_trusted(&resolve_summoner_aliases(m).await) {
                    trusted_count += 1;
                }
            }
            trusted_count == 1
        };

        if !accept {
            continue;
        }

        let name = aliases
            .into_iter()
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "umbreon#emii".to_string());

        match accept_trade_all_endpoints(trade_id).await {
            Ok(used_kind) => {
                last_accepted.store(trade_id, Ordering::Relaxed);
                eprintln!(
                    "[summtracker] auto-accepted champion swap from {name} (trade {trade_id}, via {used_kind}; hinted {kind})"
                );
            }
            Err(err) => {
                eprintln!(
                    "[summtracker] auto-accept swap from {name} failed (trade {trade_id}, kind {kind}): {err}"
                );
            }
        }
    }
}

async fn accept_trade_all_endpoints(trade_id: i64) -> Result<&'static str, String> {
    let endpoints = [
        (
            "champion-swap",
            format!("/lol-champ-select/v1/session/champion-swaps/{trade_id}/accept"),
        ),
        (
            "trade",
            format!("/lol-champ-select/v1/session/trades/{trade_id}/accept"),
        ),
        (
            "lobby-champion-swap",
            format!(
                "/lol-lobby-team-builder/champ-select/v1/session/champion-swaps/{trade_id}/accept"
            ),
        ),
        (
            "lobby-trade",
            format!("/lol-lobby-team-builder/champ-select/v1/session/trades/{trade_id}/accept"),
        ),
        (
            "position-swap",
            format!("/lol-champ-select/v1/session/position-swaps/{trade_id}/accept"),
        ),
        (
            "pick-order-swap",
            format!("/lol-champ-select/v1/session/pick-order-swaps/{trade_id}/accept"),
        ),
    ];
    let mut last_err = String::from("Trade failed");
    for (kind, path) in endpoints {
        match lcu::lcu_post(&path).await {
            Ok(_) => return Ok(kind),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}
