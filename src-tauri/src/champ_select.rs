use serde_json::{json, Value};

use crate::lcu;

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

fn member_name(member: &Value) -> String {
    [
        member.get("gameName").and_then(Value::as_str),
        member.get("riotId").and_then(Value::as_str),
        member.get("summonerName").and_then(Value::as_str),
        member.get("playerAlias").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .find(|s| !s.is_empty())
    .unwrap_or("")
    .to_string()
}

fn trade_entries(session: &Value) -> Vec<(i64, i64, String, &'static str)> {
    let mut trades = Vec::new();

    if let Some(arr) = session.get("championSwaps").and_then(Value::as_array) {
        for trade in arr {
            if let (Some(id), Some(cell)) = (json_i64(&trade["id"]), json_i64(&trade["cellId"])) {
                trades.push((
                    id,
                    cell,
                    trade["state"].as_str().unwrap_or("UNAVAILABLE").to_string(),
                    "champion-swap",
                ));
            }
        }
    }

    if trades.is_empty() {
        if let Some(arr) = session.get("trades").and_then(Value::as_array) {
            for trade in arr {
                if let (Some(id), Some(cell)) = (json_i64(&trade["id"]), json_i64(&trade["cellId"])) {
                    trades.push((
                        id,
                        cell,
                        trade["state"].as_str().unwrap_or("UNAVAILABLE").to_string(),
                        "trade",
                    ));
                }
            }
        }
    }

    trades
}

pub fn is_swap_session(session: &Value) -> bool {
    session.get("benchEnabled").and_then(Value::as_bool).unwrap_or(false)
        || !bench_ids(session).is_empty()
}

pub fn build_payload(session: &Value, gameflow: Option<&Value>, pickable: Option<&Value>) -> Value {
    let local_cell = json_i64(&session["localPlayerCellId"]).unwrap_or(-1);
    let my_team = session.get("myTeam").and_then(Value::as_array).cloned().unwrap_or_default();
    let trades = trade_entries(session);
    let bench = bench_ids(session);
    let mut cards = pickable_ids(pickable);
    if cards.len() > 6 {
        cards.clear();
    }

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
            let trade = trades.iter().find(|(_, cell, _, _)| *cell == cell_id);
            json!({
                "cellId": cell_id,
                "championId": champion_id,
                "isLocal": is_local,
                "displayName": member_name(member),
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
    if champion_id <= 0 {
        return Err("Invalid champion".to_string());
    }
    lcu::lcu_post(&format!("/lol-champ-select/v1/session/bench/swap/{champion_id}")).await?;
    Ok(())
}

#[tauri::command]
pub async fn complete_pick(action_id: i64, champion_id: i64) -> Result<(), String> {
    if action_id < 0 || champion_id <= 0 {
        return Err("Invalid pick".to_string());
    }
    lcu::lcu_patch(
        &format!("/lol-champ-select/v1/session/actions/{action_id}"),
        json!({ "championId": champion_id, "completed": true }),
    )
    .await?;
    Ok(())
}

fn trade_path(kind: &str, trade_id: i64, action: &str) -> String {
    if kind == "champion-swap" {
        format!("/lol-champ-select/v1/session/champion-swaps/{trade_id}/{action}")
    } else {
        format!("/lol-champ-select/v1/session/trades/{trade_id}/{action}")
    }
}

#[tauri::command]
pub async fn request_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    lcu::lcu_post(&trade_path(kind.as_deref().unwrap_or("trade"), trade_id, "request")).await?;
    Ok(())
}

#[tauri::command]
pub async fn accept_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    lcu::lcu_post(&trade_path(kind.as_deref().unwrap_or("trade"), trade_id, "accept")).await?;
    Ok(())
}

#[tauri::command]
pub async fn decline_trade(trade_id: i64, kind: Option<String>) -> Result<(), String> {
    lcu::lcu_post(&trade_path(kind.as_deref().unwrap_or("trade"), trade_id, "decline")).await?;
    Ok(())
}

#[tauri::command]
pub async fn reroll_champion() -> Result<(), String> {
    lcu::lcu_post("/lol-champ-select/v1/session/my-selection/reroll").await?;
    Ok(())
}
