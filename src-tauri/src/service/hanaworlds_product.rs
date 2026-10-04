use crate::config;
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::AppHandle;

fn build_id(resource_root: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(resource_root.join("hanaworlds/build-id.txt"))
        .map_err(|error| format!("HANAWORLDS_BUILD_ID_MISSING: {error}"))?;
    let id = raw.trim();
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("HANAWORLDS_BUILD_ID_INVALID".to_string());
    }
    Ok(id.to_string())
}

fn copy_core(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "HANAWORLDS_RUNTIME_PARENT_MISSING".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("HANAWORLDS_RUNTIME_CREATE: {error}"))?;
    if target.is_dir() {
        return target
            .join("node_modules/@deepseek-ai/dsh/lib/bin.js")
            .is_file()
            .then_some(())
            .ok_or_else(|| "HANAWORLDS_RUNTIME_STORED_ENTRY_MISSING".to_string());
    }
    let stage = parent.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    let result = Command::new("/usr/bin/ditto")
        .arg(source)
        .arg(&stage)
        .status()
        .map_err(|error| format!("HANAWORLDS_RUNTIME_COPY: {error}"))?;
    if !result.success() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("HANAWORLDS_RUNTIME_COPY_EXIT: {result}"));
    }
    let entry = stage.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !entry.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err("HANAWORLDS_RUNTIME_ENTRY_MISSING".to_string());
    }
    fs::rename(&stage, target).map_err(|error| {
        let _ = fs::remove_dir_all(&stage);
        format!("HANAWORLDS_RUNTIME_ACTIVATE: {error}")
    })
}

pub fn prepare(app: &AppHandle) -> Result<(), String> {
    let resources = config::manifest::resource_root(app)
        .ok_or_else(|| "HANAWORLDS_RESOURCES_MISSING".to_string())?;
    let source = config::dependencies::bundled_core_dir(app)
        .ok_or_else(|| "HANAWORLDS_BUNDLED_CORE_MISSING".to_string())?;
    let node = resources.join("node/bin/node");
    let pnpm = resources.join("pnpm/bin/pnpm.cjs");
    let plugin = resources.join("node_modules/dsh-tauri/package.json");
    for path in [&node, &pnpm, &plugin] {
        if !path.is_file() {
            return Err(format!("HANAWORLDS_BUNDLE_INCOMPLETE: {}", path.display()));
        }
    }
    let id = build_id(&resources)?;
    let core = config::get_base_dir(app).join("runtime").join(id).join("dsh");
    copy_core(&source, &core)?;
    config::dependencies::record(app, config::dependencies::DEP_DSH, Some(core.clone()));
    if config::get_dsh_install_path(app) != core {
        return Err("HANAWORLDS_RUNTIME_MAPPING_FAILED".to_string());
    }
    let profile = config::get_dsh_data_path(app).join("profiles/hanaworlds");
    if !profile.is_dir() {
        crate::service::profile::create(app, "hanaworlds")?;
    }
    crate::service::profile::set_active(app, "hanaworlds")?;
    config::update_store_dat_setting(app, |setting| {
        setting.installed = true;
        setting.active_core = Some("app".to_string());
        setting.cli_link_enabled = false;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::build_id;
    use std::fs;

    #[test]
    fn build_id_rejects_unpinned_or_path_escaping_values() {
        let root = std::env::temp_dir().join(format!("hanaworlds-build-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("hanaworlds")).unwrap();
        fs::write(root.join("hanaworlds/build-id.txt"), "../../old-project").unwrap();
        assert!(build_id(&root).is_err());
        fs::write(root.join("hanaworlds/build-id.txt"), "a".repeat(64)).unwrap();
        assert_eq!(build_id(&root).unwrap(), "a".repeat(64));
        fs::remove_dir_all(root).unwrap();
    }
}
