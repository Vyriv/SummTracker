use reqwest::Client;

const BASE: &str = "https://127.0.0.1:2999/liveclientdata";

fn debug_log(_message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[live_game] {_message}");
}

fn make_client() -> reqwest::Result<Client> {
    Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
}

pub async fn live_get(endpoint: &str) -> Result<serde_json::Value, String> {
    let client = make_client().map_err(|e| e.to_string())?;
    debug_log(&format!("GET {}", endpoint));
    let res = client
        .get(format!("{}{}", BASE, endpoint))
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            debug_log(&format!("request failed {}: {}", endpoint, msg));
            msg
        })?;

    debug_log(&format!("status {} {}", res.status(), endpoint));

    if !res.status().is_success() {
        return Err(format!("Live API {} {}", res.status(), endpoint));
    }

    res.json().await.map_err(|e| e.to_string())
}

pub async fn get_all_players() -> Result<serde_json::Value, String> {
    live_get("/playerlist").await
}

pub async fn get_all_game_data() -> Result<serde_json::Value, String> {
    live_get("/allgamedata").await
}

pub async fn get_active_player() -> Result<serde_json::Value, String> {
    live_get("/activeplayer").await
}

pub async fn is_game_running() -> bool {
    match live_get("/gamestats").await {
        Ok(_) => {
            debug_log("gamestats probe succeeded");
            true
        }
        Err(err) => {
            debug_log(&format!("gamestats probe failed: {}", err));
            false
        }
    }
}
