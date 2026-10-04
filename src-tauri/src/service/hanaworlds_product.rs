use crate::config;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
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

fn write_once(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            return (fs::read(path).map_err(|e| format!("HANAWORLDS_MIGRATION_READ: {e}"))?
                == bytes)
                .then_some(())
                .ok_or_else(|| "HANAWORLDS_MIGRATION_SNAPSHOT_CONFLICT".to_string());
        }
        Ok(_) => return Err("HANAWORLDS_MIGRATION_SNAPSHOT_INVALID".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("HANAWORLDS_MIGRATION_SNAPSHOT_STAT: {error}")),
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("HANAWORLDS_MIGRATION_SNAPSHOT_CREATE: {e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("HANAWORLDS_MIGRATION_SNAPSHOT_WRITE: {e}"))
}

fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("hanaworlds-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("HANAWORLDS_MIGRATION_WRITE: {error}"));
    }
    Ok(())
}

fn migrate_legacy_profile(profile: &Path) -> Result<bool, String> {
    let manifest_path = profile.join("package.json");
    let patch_path = profile.join("cordis.patch.yml");
    for path in [&manifest_path, &patch_path] {
        let metadata = fs::symlink_metadata(path)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_INPUT_STAT: {e}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("HANAWORLDS_MIGRATION_INPUT_INVALID".to_string());
        }
    }
    let raw_manifest =
        fs::read(&manifest_path).map_err(|e| format!("HANAWORLDS_MIGRATION_MANIFEST_READ: {e}"))?;
    let mut manifest: serde_json::Value = serde_json::from_slice(&raw_manifest)
        .map_err(|e| format!("HANAWORLDS_MIGRATION_MANIFEST_PARSE: {e}"))?;
    let bundles = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .ok_or("HANAWORLDS_MIGRATION_BUNDLES_INVALID")?;
    let legacy_count = bundles
        .iter()
        .filter(|value| {
            value
                .as_str()
                .is_some_and(|s| s.starts_with("@hanaworlds/"))
        })
        .count();
    if legacy_count > 0
        && manifest
            .pointer("/dependencies/@hanaworlds~1dsh-shell")
            .is_none()
    {
        return Err("HANAWORLDS_MIGRATION_UNKNOWN_LEGACY_GRAPH".to_string());
    }
    if legacy_count > 0
        && !manifest
            .get("hanaworlds")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err("HANAWORLDS_MIGRATION_METADATA_INVALID".to_string());
    }
    let snapshot = profile.join(".hanaworlds-client-migration");
    let marker = manifest.pointer("/hanaworlds/clientMigration").is_some();
    if legacy_count == 0 && !marker {
        return Ok(false);
    }
    if snapshot.exists() {
        let metadata = fs::symlink_metadata(&snapshot)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_SNAPSHOT_STAT: {e}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("HANAWORLDS_MIGRATION_SNAPSHOT_INVALID".to_string());
        }
    } else {
        fs::create_dir(&snapshot)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_SNAPSHOT_MKDIR: {e}"))?;
    }
    #[cfg(unix)]
    fs::set_permissions(
        &snapshot,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|e| format!("HANAWORLDS_MIGRATION_SNAPSHOT_PERMISSIONS: {e}"))?;
    let saved_manifest = snapshot.join("legacy-package.json");
    let saved_patch = snapshot.join("legacy-cordis.patch.yml");
    if legacy_count > 0 {
        write_once(&saved_manifest, &raw_manifest)?;
    } else {
        let metadata = fs::symlink_metadata(&saved_manifest)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_MANIFEST_SNAPSHOT_STAT: {e}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("HANAWORLDS_MIGRATION_MANIFEST_SNAPSHOT_INVALID".to_string());
        }
    }
    let raw_patch =
        fs::read(&patch_path).map_err(|e| format!("HANAWORLDS_MIGRATION_PATCH_READ: {e}"))?;
    let saved_patch_exists = match fs::symlink_metadata(&saved_patch) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Ok(_) => return Err("HANAWORLDS_MIGRATION_PATCH_SNAPSHOT_INVALID".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("HANAWORLDS_MIGRATION_PATCH_SNAPSHOT_STAT: {error}")),
    };
    if !saved_patch_exists {
        let patch: serde_yaml::Value = serde_yaml::from_slice(&raw_patch)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_PATCH_PARSE: {e}"))?;
        let entries = patch
            .as_sequence()
            .ok_or("HANAWORLDS_MIGRATION_PATCH_INVALID")?;
        if entries.iter().any(|entry| {
            !entry
                .get("id")
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|id| id.starts_with("hanaworlds-"))
        }) {
            return Err("HANAWORLDS_MIGRATION_PATCH_HAS_OTHER_ENTRIES".to_string());
        }
        write_once(&saved_patch, &raw_patch)?;
    } else if raw_patch != b"[]\n"
        && fs::read(&saved_patch)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_PATCH_SNAPSHOT_READ: {e}"))?
            != raw_patch
    {
        return Err("HANAWORLDS_MIGRATION_PATCH_SNAPSHOT_CONFLICT".to_string());
    }
    if raw_patch != b"[]\n" {
        replace_file(&patch_path, b"[]\n")?;
    }
    if legacy_count > 0 {
        let original_digest = format!("{:x}", Sha256::digest(&raw_manifest));
        manifest
            .pointer_mut("/dsh/profile/bundles")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or("HANAWORLDS_MIGRATION_BUNDLES_INVALID")?
            .retain(|value| {
                !value
                    .as_str()
                    .is_some_and(|s| s.starts_with("@hanaworlds/"))
            });
        manifest
            .get_mut("hanaworlds")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or("HANAWORLDS_MIGRATION_METADATA_INVALID")?
            .insert(
                "clientMigration".to_string(),
                serde_json::json!({
                    "state": "legacy-plugins-preserved-inactive",
                    "savedBundleCount": legacy_count,
                    "originalManifestSha256": original_digest,
                    "snapshot": ".hanaworlds-client-migration"
                }),
            );
        let rendered = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("HANAWORLDS_MIGRATION_MANIFEST_RENDER: {e}"))?;
        let mut content = rendered;
        content.push(b'\n');
        replace_file(&manifest_path, &content)?;
    }
    Ok(true)
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
    let node_version = Command::new(&node)
        .arg("--version")
        .output()
        .map_err(|e| format!("HANAWORLDS_NODE_VERSION_READ: {e}"))?;
    if !node_version.status.success() || node_version.stdout != b"v24.13.1\n" {
        return Err("HANAWORLDS_NODE_VERSION_REQUIRED: v24.13.1".to_string());
    }
    let id = build_id(&resources)?;
    let core = config::get_base_dir(app)
        .join("runtime")
        .join(id)
        .join("dsh");
    copy_core(&source, &core)?;
    config::dependencies::record(app, config::dependencies::DEP_DSH, Some(core.clone()));
    if config::get_dsh_install_path(app) != core {
        return Err("HANAWORLDS_RUNTIME_MAPPING_FAILED".to_string());
    }
    let profile = config::get_dsh_data_path(app).join("profiles/hanaworlds");
    if !profile.is_dir() {
        crate::service::profile::create(app, "hanaworlds")?;
    } else {
        migrate_legacy_profile(&profile)?;
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
    use super::{build_id, migrate_legacy_profile};
    use std::fs;

    #[test]
    fn build_id_rejects_unpinned_or_path_escaping_values() {
        let root =
            std::env::temp_dir().join(format!("hanaworlds-build-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("hanaworlds")).unwrap();
        fs::write(root.join("hanaworlds/build-id.txt"), "../../old-project").unwrap();
        assert!(build_id(&root).is_err());
        fs::write(root.join("hanaworlds/build-id.txt"), "a".repeat(64)).unwrap();
        assert_eq!(build_id(&root).unwrap(), "a".repeat(64));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_graph_is_preserved_and_deactivated_in_the_same_profile() {
        let root =
            std::env::temp_dir().join(format!("hanaworlds-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let original = br#"{"name":"dsh-profile-hanaworlds","dependencies":{"@hanaworlds/dsh-shell":"file:./old.tgz"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@hanaworlds/dsh-shell"]}},"hanaworlds":{"releaseId":"old"}}"#;
        let patch = b"- id: hanaworlds-shell\n  config: {}\n";
        fs::write(root.join("package.json"), original).unwrap();
        fs::write(root.join("cordis.patch.yml"), patch).unwrap();

        assert_eq!(migrate_legacy_profile(&root).unwrap(), true);
        assert_eq!(migrate_legacy_profile(&root).unwrap(), true);
        assert_eq!(
            fs::read(root.join(".hanaworlds-client-migration/legacy-package.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read(root.join(".hanaworlds-client-migration/legacy-cordis.patch.yml")).unwrap(),
            patch
        );
        let current: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(
            current["dependencies"]["@hanaworlds/dsh-shell"],
            "file:./old.tgz"
        );
        assert_eq!(
            current["dsh"]["profile"]["bundles"],
            serde_json::json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );
        assert_eq!(current["hanaworlds"]["releaseId"], "old");
        assert_eq!(
            current["hanaworlds"]["clientMigration"]["savedBundleCount"],
            1
        );
        assert_eq!(fs::read(root.join("cordis.patch.yml")).unwrap(), b"[]\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_patch_with_unrelated_user_entry_refuses_migration() {
        let root =
            std::env::temp_dir().join(format!("hanaworlds-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let manifest = br#"{"dependencies":{"@hanaworlds/dsh-shell":"file:./old.tgz"},"dsh":{"profile":{"bundles":["@hanaworlds/dsh-shell"]}},"hanaworlds":{}}"#;
        let patch = b"- id: user-plugin\n  config: {}\n";
        fs::write(root.join("package.json"), manifest).unwrap();
        fs::write(root.join("cordis.patch.yml"), patch).unwrap();
        assert!(migrate_legacy_profile(&root)
            .unwrap_err()
            .contains("PATCH_HAS_OTHER_ENTRIES"));
        assert_eq!(fs::read(root.join("package.json")).unwrap(), manifest);
        assert_eq!(fs::read(root.join("cordis.patch.yml")).unwrap(), patch);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn legacy_snapshot_symlink_refuses_migration_without_changing_profile() {
        let root =
            std::env::temp_dir().join(format!("hanaworlds-migration-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("hanaworlds-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let manifest = br#"{"dependencies":{"@hanaworlds/dsh-shell":"file:./old.tgz"},"dsh":{"profile":{"bundles":["@hanaworlds/dsh-shell"]}},"hanaworlds":{}}"#;
        let patch = b"- id: hanaworlds-shell\n  config: {}\n";
        fs::write(root.join("package.json"), manifest).unwrap();
        fs::write(root.join("cordis.patch.yml"), patch).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".hanaworlds-client-migration")).unwrap();
        assert!(migrate_legacy_profile(&root)
            .unwrap_err()
            .contains("SNAPSHOT_INVALID"));
        assert_eq!(fs::read(root.join("package.json")).unwrap(), manifest);
        assert_eq!(fs::read(root.join("cordis.patch.yml")).unwrap(), patch);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
