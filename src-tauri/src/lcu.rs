use std::fs;
use reqwest::{Client, Method};
use serde_json::Value;

const LOCKFILE_PATHS: &[&str] = &[
    "C:\\Riot Games\\League of Legends\\lockfile",
    "D:\\Riot Games\\League of Legends\\lockfile",
];

struct LcuLock {
    port: u16,
    password: String,
}

fn make_client() -> reqwest::Result<Client> {
    Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
}

fn read_lockfile() -> Option<LcuLock> {
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let dynamic = format!("{}\\Riot Games\\League of Legends\\lockfile", localappdata);

    let paths: Vec<&str> = LOCKFILE_PATHS.iter().map(|s| s.as_ref())
        .chain(std::iter::once(dynamic.as_str()))
        .collect();

    for path in paths {
        if let Ok(content) = fs::read_to_string(path) {
            let parts: Vec<&str> = content.splitn(5, ':').collect();
            if parts.len() >= 5 {
                if let Ok(port) = parts[2].parse::<u16>() {
                    return Some(LcuLock { port, password: parts[3].to_string() });
                }
            }
        }
    }
    None
}

pub fn is_client_running() -> bool {
    read_lockfile().is_some()
}

pub async fn lcu_fetch(endpoint: &str) -> Result<Value, String> {
    lcu_request(Method::GET, endpoint, None).await
}

pub async fn lcu_post(endpoint: &str) -> Result<Value, String> {
    lcu_request(Method::POST, endpoint, None).await
}

pub async fn lcu_patch(endpoint: &str, body: Value) -> Result<Value, String> {
    lcu_request(Method::PATCH, endpoint, Some(body)).await
}

pub async fn lcu_request(method: Method, endpoint: &str, body: Option<Value>) -> Result<Value, String> {
    let lock = read_lockfile().ok_or_else(|| "League client not running".to_string())?;
    let client = make_client().map_err(|e| e.to_string())?;
    let url = format!("https://127.0.0.1:{}{}", lock.port, endpoint);

    let mut req = client
        .request(method, &url)
        .basic_auth("riot", Some(&lock.password));

    if let Some(body) = body {
        req = req.json(&body);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    if !status.is_success() {
        let detail = if text.is_empty() {
            status.to_string()
        } else {
            text.chars().take(180).collect()
        };
        return Err(format!("LCU {} {}: {}", status, endpoint, detail));
    }

    if text.is_empty() {
        return Ok(Value::Null);
    }

    serde_json::from_str(&text).or_else(|_| Ok(Value::String(text)))
}

pub async fn get_champ_select_session() -> Option<Value> {
    lcu_fetch("/lol-champ-select/v1/session").await.ok()
}

pub async fn get_gameflow_session() -> Option<Value> {
    lcu_fetch("/lol-gameflow/v1/session").await.ok()
}

pub async fn get_ready_check() -> Option<Value> {
    lcu_fetch("/lol-matchmaking/v1/ready-check").await.ok()
}

pub async fn accept_ready_check() -> Result<(), String> {
    // Prefer matchmaking accept; fall back to lobby-team-builder (used by some queues).
    match lcu_post("/lol-matchmaking/v1/ready-check/accept").await {
        Ok(_) => Ok(()),
        Err(err) => {
            lcu_post("/lol-lobby-team-builder/v1/ready-check/accept")
                .await
                .map(|_| ())
                .map_err(|_| err)
        }
    }
}

pub async fn get_pickable_champions() -> Option<Value> {
    lcu_fetch("/lol-champ-select/v1/pickable-champions").await.ok()
}

pub async fn get_subset_champion_list() -> Option<Value> {
    lcu_fetch("/lol-lobby-team-builder/champ-select/v1/subset-champion-list").await.ok()
}
