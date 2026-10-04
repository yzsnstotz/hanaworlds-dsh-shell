use serde_json::Value;
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, WebviewWindow};

static DESKTOP_TOKEN: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn token_cell() -> &'static RwLock<Option<String>> {
    DESKTOP_TOKEN.get_or_init(|| RwLock::new(None))
}

pub fn install_token(token: String) {
    *token_cell()
        .write()
        .expect("hanaworlds token lock poisoned") = Some(token);
}

pub fn clear_token() {
    *token_cell()
        .write()
        .expect("hanaworlds token lock poisoned") = None;
}

#[tauri::command]
pub async fn hanaworlds_request(
    app_handle: AppHandle,
    window: WebviewWindow,
    operation: String,
    input: Value,
) -> Result<Value, String> {
    let trusted_page = window.url().ok().is_some_and(|url| {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420))
    });
    if window.label() != crate::desktop::builder::MAIN_WINDOW_LABEL || !trusted_page {
        return Err("HANAWORLDS_OPERATION_DENIED: untrusted window".to_string());
    }
    if cfg!(feature = "hanaworlds-product") && operation == "profileStatus" {
        return crate::service::hanaworlds_product::profile_status(&app_handle);
    }
    let path = match operation.as_str() {
        "context" => "context",
        "bind" => "bindings",
        "workshop" => "workshop",
        _ => return Err("HANAWORLDS_OPERATION_DENIED: unknown operation".to_string()),
    };
    let token = token_cell()
        .read()
        .map_err(|_| "HANAWORLDS_UNAVAILABLE: token state unavailable".to_string())?
        .clone()
        .ok_or_else(|| "HANAWORLDS_UNAVAILABLE: desktop host is not running".to_string())?;
    let port = crate::config::get_store_dat_setting(&app_handle).port;
    let url = format!("http://127.0.0.1:{port}/api/desktop/hanaworlds/{path}");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "HANAWORLDS_UNAVAILABLE: client setup failed".to_string())?;
    let response = client
        .post(url)
        .header("x-hanaworlds-desktop-token", token)
        .json(&input)
        .send()
        .await
        .map_err(|error| format!("HANAWORLDS_HOST_UNAVAILABLE: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("HANAWORLDS_HOST_INVALID_RESPONSE: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "HANAWORLDS_REQUEST_DENIED: {}",
            body.get("error")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN")
        ));
    }
    Ok(body)
}
