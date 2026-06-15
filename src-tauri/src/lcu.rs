use std::fs;
use reqwest::Client;

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

pub async fn lcu_fetch(endpoint: &str) -> Result<serde_json::Value, String> {
    let lock = read_lockfile().ok_or_else(|| "League client not running".to_string())?;
    let client = make_client().map_err(|e| e.to_string())?;
    let url = format!("https://127.0.0.1:{}{}", lock.port, endpoint);

    let res = client
        .get(&url)
        .basic_auth("riot", Some(&lock.password))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("LCU {} {}", res.status(), endpoint));
    }

    res.json().await.map_err(|e| e.to_string())
}

pub async fn get_champ_select_session() -> Option<serde_json::Value> {
    lcu_fetch("/lol-champ-select/v1/session").await.ok()
}

pub async fn get_gameflow_session() -> Option<serde_json::Value> {
    lcu_fetch("/lol-gameflow/v1/session").await.ok()
}
