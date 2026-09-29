use std::fs;
use std::path::Path;
use tauri::AppHandle;

pub(crate) fn reconcile_removed_plugin_residue(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    if crate::service::core::active_source(app_handle) != crate::service::core::CoreSource::App {
        return Ok(Vec::new());
    }
    reconcile_at(
        &super::profile_dir(app_handle),
        &crate::config::get_dsh_install_path(app_handle),
    )
}

// Core's native Plugins UI emits plugin-manager/changed after removeBundle finishes.
// The desktop bridge calls this once for that event. Only fully absent plugins
// with a Shell-owned Core link can be reconciled; failed/partial removals stay put.
fn reconcile_at(profile: &Path, core_root: &Path) -> Result<Vec<String>, String> {
    let modules = core_root.join("node_modules");
    let profile_modules = profile.join("node_modules");
    let expected_root = match profile_modules.canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => profile
            .canonicalize()
            .map_err(|e| format!("PLUGIN_UNINSTALL_PROFILE_ROOT: {}: {e}", profile.display()))?
            .join("node_modules"),
        Err(e) => return Err(format!("PLUGIN_UNINSTALL_PROFILE_MODULES: {}: {e}", profile_modules.display())),
    };
    let lock = read_lock(profile)?;
    let mut names = Vec::new();
    let entries = match fs::read_dir(&modules) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(e) => return Err(format!("PLUGIN_UNINSTALL_CORE_MODULES_READ: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("PLUGIN_UNINSTALL_CORE_ENTRY_READ: {e}"))?;
        let Some(top) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if top.starts_with('@') && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let children = fs::read_dir(entry.path())
                .map_err(|e| format!("PLUGIN_UNINSTALL_CORE_SCOPE_READ: {e}"))?;
            for child in children {
                let child = child.map_err(|e| format!("PLUGIN_UNINSTALL_CORE_ENTRY_READ: {e}"))?;
                if let Some(part) = child.file_name().to_str() {
                    names.push(format!("{top}/{part}"));
                }
            }
        } else {
            names.push(top);
        }
    }
    let mut removed = Vec::new();
    for name in names {
        if !super::recovery::is_actionable_plugin_ref(&name)
            || lock.as_ref().is_some_and(|lock| lock_references_package(lock, &name))
        {
            continue;
        }
        let anchor = modules.join(&name);
        if !fs::symlink_metadata(&anchor).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            continue;
        }
        if fs::read_link(&anchor).ok().as_deref() != Some(expected_root.join(&name).as_path()) {
            continue;
        }
        if fs::symlink_metadata(profile_modules.join(&name)).is_ok() {
            continue;
        }
        // cleanup_at checks package dependencies/bundles again before writing.
        match cleanup_at(profile, Some(core_root), &name) {
            Ok(()) => removed.push(name),
            Err(e) if e.starts_with("PLUGIN_UNINSTALL_STILL_DECLARED:") => {},
            Err(e) => return Err(e),
        }
    }
    Ok(removed)
}

fn read_lock(profile: &Path) -> Result<Option<serde_yaml::Value>, String> {
    Ok(match fs::read_to_string(profile.join("pnpm-lock.yaml")) {
        Ok(content) => {
            let document: serde_yaml::Value = serde_yaml::from_str(&content)
                .map_err(|e| format!("PLUGIN_UNINSTALL_LOCK_PARSE: {e}"))?;
            if !document.is_mapping() {
                return Err("PLUGIN_UNINSTALL_LOCK_PARSE: expected a mapping".to_string());
            }
            if !document
                .get("lockfileVersion")
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|version| !version.trim().is_empty())
            {
                return Err("PLUGIN_UNINSTALL_LOCK_PARSE: missing lockfileVersion".to_string());
            }
            if !document.get("importers").is_some_and(serde_yaml::Value::is_mapping) {
                return Err("PLUGIN_UNINSTALL_LOCK_PARSE: missing importers mapping".to_string());
            }
            for section in ["importers", "packages", "snapshots"] {
                if document.get(section).is_some_and(|value| !value.is_mapping()) {
                    return Err(format!("PLUGIN_UNINSTALL_LOCK_PARSE: {section} must be a mapping"));
                }
            }
            if let Some(importers) = document.get("importers").and_then(serde_yaml::Value::as_mapping) {
                for importer in importers.values() {
                    if !importer.is_mapping() {
                        return Err("PLUGIN_UNINSTALL_LOCK_PARSE: importer must be a mapping".to_string());
                    }
                    for section in ["dependencies", "devDependencies", "optionalDependencies"] {
                        if importer.get(section).is_some_and(|value| !value.is_mapping()) {
                            return Err(format!("PLUGIN_UNINSTALL_LOCK_PARSE: importer {section} must be a mapping"));
                        }
                    }
                }
            }
            Some(document)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("PLUGIN_UNINSTALL_LOCK_READ: {e}")),
    })
}

fn lock_references_package(lock: &serde_yaml::Value, name: &str) -> bool {
    if let Some(importers) = lock.get("importers").and_then(serde_yaml::Value::as_mapping) {
        for importer in importers.values() {
            for section in ["dependencies", "devDependencies", "optionalDependencies"] {
                if importer
                    .get(section)
                    .and_then(serde_yaml::Value::as_mapping)
                    .is_some_and(|entries| entries.keys().any(|key| key.as_str() == Some(name)))
                {
                    return true;
                }
            }
        }
    }
    for section in ["packages", "snapshots"] {
        if lock
            .get(section)
            .and_then(serde_yaml::Value::as_mapping)
            .is_some_and(|entries| {
                entries.keys().any(|key| {
                    key.as_str().is_some_and(|key| {
                        let key = key.strip_prefix('/').unwrap_or(key);
                        key == name
                            || key
                                .strip_prefix(name)
                                .is_some_and(|suffix| suffix.starts_with('@') && suffix.len() > 1)
                    })
                })
            })
        {
            return true;
        }
    }
    false
}

pub(crate) fn cleanup_after_uninstall(app_handle: &AppHandle, name: &str) -> Result<(), String> {
    let profile = super::profile_dir(app_handle);
    let core_root = (crate::service::core::active_source(app_handle)
        == crate::service::core::CoreSource::App)
        .then(|| crate::config::get_dsh_install_path(app_handle));
    cleanup_at(&profile, core_root.as_deref(), name)
}

fn cleanup_at(profile: &Path, core_root: Option<&Path>, name: &str) -> Result<(), String> {
    if !super::recovery::is_actionable_plugin_ref(name) {
        return Err(format!("PLUGIN_UNINSTALL_NAME_INVALID: {name}"));
    }
    let manifest_path = profile.join("package.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| {
            format!(
                "PLUGIN_UNINSTALL_MANIFEST_READ: {}: {e}",
                manifest_path.display()
            )
        })?)
        .map_err(|e| {
            format!(
                "PLUGIN_UNINSTALL_MANIFEST_PARSE: {}: {e}",
                manifest_path.display()
            )
        })?;
    let dependencies = manifest.get("dependencies").and_then(|v| v.as_object());
    let bundles = manifest
        .get("dsh")
        .and_then(|v| v.get("profile"))
        .and_then(|v| v.get("bundles"))
        .and_then(|v| v.as_array());
    if dependencies.is_some_and(|deps| deps.contains_key(name))
        || bundles.is_some_and(|items| items.iter().any(|item| item.as_str() == Some(name)))
    {
        return Err(format!("PLUGIN_UNINSTALL_STILL_DECLARED: {name}"));
    }
    if read_lock(profile)?.as_ref().is_some_and(|lock| lock_references_package(lock, name)) {
        return Err(format!("PLUGIN_UNINSTALL_STILL_LOCKED: {name}"));
    }
    let installed = profile.join("node_modules").join(name);
    match fs::symlink_metadata(&installed) {
        Ok(_) => return Err(format!("PLUGIN_UNINSTALL_STILL_INSTALLED: {}", installed.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(format!("PLUGIN_UNINSTALL_INSTALLED_STAT: {}: {e}", installed.display())),
    }

    remove_release_age_exceptions(profile, name)?;
    if let Some(core_root) = core_root {
        remove_owned_core_link(profile, core_root, name)?;
    }
    Ok(())
}

fn remove_owned_core_link(profile: &Path, core_root: &Path, name: &str) -> Result<(), String> {
    let modules = core_root.join("node_modules");
    let destination = modules.join(name);
    let Some(parent) = destination.parent() else {
        return Ok(());
    };
    for path in [modules.as_path(), parent] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "PLUGIN_UNINSTALL_CORE_PARENT_LINK: {}",
                    path.display()
                ));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "PLUGIN_UNINSTALL_CORE_PARENT_INVALID: {}",
                    path.display()
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(format!(
                    "PLUGIN_UNINSTALL_CORE_PARENT_STAT: {}: {e}",
                    path.display()
                ))
            }
        }
    }
    let metadata = match fs::symlink_metadata(&destination) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "PLUGIN_UNINSTALL_CORE_LINK_STAT: {}: {e}",
                destination.display()
            ))
        }
    };
    if !metadata.file_type().is_symlink() {
        return Ok(());
    }
    let profile_modules = profile.join("node_modules");
    let expected_root = match profile_modules.canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => profile
            .canonicalize()
            .map_err(|e| format!("PLUGIN_UNINSTALL_PROFILE_ROOT: {}: {e}", profile.display()))?
            .join("node_modules"),
        Err(e) => {
            return Err(format!(
                "PLUGIN_UNINSTALL_PROFILE_MODULES: {}: {e}",
                profile_modules.display()
            ))
        }
    };
    let expected = expected_root.join(name);
    let target = fs::read_link(&destination).map_err(|e| {
        format!(
            "PLUGIN_UNINSTALL_CORE_LINK_READ: {}: {e}",
            destination.display()
        )
    })?;
    if target != expected {
        return Ok(());
    }
    #[cfg(windows)]
    let result = fs::remove_dir(&destination).or_else(|_| fs::remove_file(&destination));
    #[cfg(not(windows))]
    let result = fs::remove_file(&destination);
    result.map_err(|e| {
        format!(
            "PLUGIN_UNINSTALL_CORE_LINK_REMOVE: {}: {e}",
            destination.display()
        )
    })
}

fn remove_release_age_exceptions(profile: &Path, name: &str) -> Result<(), String> {
    let workspace_path = profile.join("pnpm-workspace.yaml");
    match fs::read_to_string(&workspace_path) {
        Ok(content) => {
            let (mut document, _) = crate::service::profile::parse_workspace_document(&content)
                .map_err(|e| {
                    format!(
                        "PLUGIN_UNINSTALL_WORKSPACE_PARSE: {}: {e}",
                        workspace_path.display()
                    )
                })?;
            if let Some(sequence) = document
                .as_mapping_mut()
                .and_then(|map| {
                    map.get_mut(serde_yaml::Value::String("minimumReleaseAgeExclude".into()))
                })
                .and_then(serde_yaml::Value::as_sequence_mut)
            {
                let before = sequence.len();
                sequence.retain(|value| {
                    !value
                        .as_str()
                        .is_some_and(|entry| package_exception(entry, name))
                });
                if sequence.len() != before {
                    let output = serde_yaml::to_string(&document)
                        .map_err(|e| format!("PLUGIN_UNINSTALL_WORKSPACE_RENDER: {e}"))?;
                    fs::write(&workspace_path, output).map_err(|e| {
                        format!(
                            "PLUGIN_UNINSTALL_WORKSPACE_WRITE: {}: {e}",
                            workspace_path.display()
                        )
                    })?;
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "PLUGIN_UNINSTALL_WORKSPACE_READ: {}: {e}",
                workspace_path.display()
            ))
        }
    }

    let state_path = profile.join("node_modules/.pnpm-workspace-state-v1.json");
    match fs::read(&state_path) {
        Ok(bytes) => {
            let mut state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
                format!(
                    "PLUGIN_UNINSTALL_WORKSPACE_STATE_PARSE: {}: {e}",
                    state_path.display()
                )
            })?;
            if let Some(sequence) = state
                .get_mut("settings")
                .and_then(|v| v.get_mut("minimumReleaseAgeExclude"))
                .and_then(serde_json::Value::as_array_mut)
            {
                let before = sequence.len();
                sequence.retain(|value| {
                    !value
                        .as_str()
                        .is_some_and(|entry| package_exception(entry, name))
                });
                if sequence.len() != before {
                    let output = serde_json::to_vec_pretty(&state)
                        .map_err(|e| format!("PLUGIN_UNINSTALL_WORKSPACE_STATE_RENDER: {e}"))?;
                    fs::write(&state_path, output).map_err(|e| {
                        format!(
                            "PLUGIN_UNINSTALL_WORKSPACE_STATE_WRITE: {}: {e}",
                            state_path.display()
                        )
                    })?;
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "PLUGIN_UNINSTALL_WORKSPACE_STATE_READ: {}: {e}",
                state_path.display()
            ))
        }
    }
    Ok(())
}

fn package_exception(entry: &str, name: &str) -> bool {
    entry
        .strip_prefix(name)
        .is_some_and(|suffix| suffix.starts_with('@') && suffix.len() > 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hanaworlds-uninstall-cleanup-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn removed_plugin_cleans_only_its_dangling_anchor_and_release_age_state() {
        let root = fixture_root();
        let profile = root.join("home/.hanaworlds-dsh/profiles/tauri");
        let core = root.join("app/dependencies/dsh");
        let profile_modules = profile.join("node_modules");
        let plugin = profile_modules.join("dsh-plugin-whale-pet");
        let core_modules = core.join("node_modules");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(&core_modules).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{"other-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["other-plugin"]}}}"#).unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "packages:\n  - .\nminimumReleaseAgeExclude:\n  - zod@4.4.3\n  - dsh-plugin-whale-pet@0.2.8\n  - dsh-plugin-whale-pet@0.2.9\n  - dsh-plugin-whale-pet-extra@1.0.0\n").unwrap();
        fs::write(profile_modules.join(".pnpm-workspace-state-v1.json"), r#"{"settings":{"minimumReleaseAgeExclude":["zod@4.4.3","dsh-plugin-whale-pet@0.2.8","dsh-plugin-whale-pet@0.2.9","dsh-plugin-whale-pet-extra@1.0.0"]},"projects":{"other":"untouched"}}"#).unwrap();
        let anchor = core_modules.join("dsh-plugin-whale-pet");
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor)
            .unwrap();
        fs::remove_dir(&plugin).unwrap();
        assert!(fs::symlink_metadata(&anchor)
            .unwrap()
            .file_type()
            .is_symlink());

        cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap();

        assert!(fs::symlink_metadata(&anchor).is_err());
        let policy = fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap();
        assert!(!policy.contains("dsh-plugin-whale-pet@"));
        assert!(policy.contains("zod@4.4.3"));
        assert!(policy.contains("dsh-plugin-whale-pet-extra@1.0.0"));
        let state: serde_json::Value = serde_json::from_slice(
            &fs::read(profile_modules.join(".pnpm-workspace-state-v1.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            state["settings"]["minimumReleaseAgeExclude"],
            serde_json::json!(["zod@4.4.3", "dsh-plugin-whale-pet-extra@1.0.0"])
        );
        assert_eq!(state["projects"]["other"], "untouched");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_plugin_keeps_link_and_release_age_policy() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(
            profile.join("package.json"),
            r#"{"dependencies":{"dsh-plugin-whale-pet":"0.2.9"}}"#,
        )
        .unwrap();
        let policy = "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n";
        fs::write(profile.join("pnpm-workspace.yaml"), policy).unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor)
            .unwrap();

        let error = cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap_err();

        assert!(error.contains("PLUGIN_UNINSTALL_STILL_DECLARED"));
        assert!(fs::symlink_metadata(&anchor)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap(),
            policy
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn foreign_core_link_is_preserved_after_plugin_uninstall() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let foreign = root.join("foreign");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(profile.join("node_modules")).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::create_dir_all(&foreign).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        crate::service::core::create_directory_link(&foreign.canonicalize().unwrap(), &anchor)
            .unwrap();

        cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap();

        assert!(fs::symlink_metadata(&anchor)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(&anchor).unwrap(),
            foreign.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn last_plugin_cleanup_handles_removed_profile_node_modules_directory() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor)
            .unwrap();
        fs::remove_dir_all(profile.join("node_modules")).unwrap();

        cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap();

        assert!(fs::symlink_metadata(&anchor).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn core_remove_event_reconciles_only_after_profile_package_lock_and_files_are_gone() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-plugin-whale-pet:\n        specifier: 0.2.9\n        version: 0.2.9\npackages:\n  dsh-plugin-whale-pet@0.2.9: {}\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - zod@4.4.3\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
        fs::write(profile.join("node_modules/.pnpm-workspace-state-v1.json"), r#"{"settings":{"minimumReleaseAgeExclude":["zod@4.4.3","dsh-plugin-whale-pet@0.2.9"]}}"#).unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor).unwrap();

        assert!(reconcile_at(&profile, &core).unwrap().is_empty());
        assert!(fs::symlink_metadata(&anchor).is_ok());
        assert!(fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@0.2.9"));

        fs::remove_dir(&plugin).unwrap();
        assert!(reconcile_at(&profile, &core).unwrap().is_empty());
        assert!(fs::symlink_metadata(&anchor).is_ok());

        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n").unwrap();
        assert_eq!(reconcile_at(&profile, &core).unwrap(), vec!["dsh-plugin-whale-pet"]);
        assert!(fs::symlink_metadata(&anchor).is_err());
        assert!(!fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@"));
        let state: serde_json::Value = serde_json::from_slice(&fs::read(profile.join("node_modules/.pnpm-workspace-state-v1.json")).unwrap()).unwrap();
        assert_eq!(state["settings"]["minimumReleaseAgeExclude"], serde_json::json!(["zod@4.4.3"]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn longer_installed_package_name_in_lock_does_not_keep_removed_prefix_anchor() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let modules = profile.join("node_modules");
        let whale = modules.join("dsh-plugin-whale-pet");
        let extra = modules.join("dsh-plugin-whale-pet-extra");
        let whale_anchor = core.join("node_modules/dsh-plugin-whale-pet");
        let extra_anchor = core.join("node_modules/dsh-plugin-whale-pet-extra");
        fs::create_dir_all(&whale).unwrap();
        fs::create_dir_all(&extra).unwrap();
        fs::create_dir_all(whale_anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{"dsh-plugin-whale-pet-extra":"1.0.0"}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-plugin-whale-pet-extra:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  dsh-plugin-whale-pet-extra@1.0.0:\n    resolution: {integrity: fixture}\nsnapshots:\n  dsh-plugin-whale-pet-extra@1.0.0: {}\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n  - dsh-plugin-whale-pet-extra@1.0.0\n").unwrap();
        crate::service::core::create_directory_link(&whale.canonicalize().unwrap(), &whale_anchor).unwrap();
        crate::service::core::create_directory_link(&extra.canonicalize().unwrap(), &extra_anchor).unwrap();
        fs::remove_dir(&whale).unwrap();

        assert_eq!(reconcile_at(&profile, &core).unwrap(), vec!["dsh-plugin-whale-pet"]);
        assert!(fs::symlink_metadata(&whale_anchor).is_err());
        assert!(fs::symlink_metadata(&extra_anchor).is_ok());
        let policy = fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap();
        assert!(!policy.contains("dsh-plugin-whale-pet@"));
        assert!(policy.contains("dsh-plugin-whale-pet-extra@1.0.0"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_lock_does_not_keep_fully_removed_plugin_residue() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let whale = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&whale).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - zod@4.4.3\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
        crate::service::core::create_directory_link(&whale.canonicalize().unwrap(), &anchor).unwrap();
        fs::remove_dir(&whale).unwrap();

        assert_eq!(reconcile_at(&profile, &core).unwrap(), vec!["dsh-plugin-whale-pet"]);
        assert!(fs::symlink_metadata(&anchor).is_err());
        let policy = fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap();
        assert!(!policy.contains("dsh-plugin-whale-pet@"));
        assert!(policy.contains("zod@4.4.3"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_existing_lock_preserves_anchor_and_policy() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let whale = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&whale).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "importers: [\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
        crate::service::core::create_directory_link(&whale.canonicalize().unwrap(), &anchor).unwrap();
        fs::remove_dir(&whale).unwrap();

        assert!(reconcile_at(&profile, &core).unwrap_err().contains("PLUGIN_UNINSTALL_LOCK_PARSE"));
        assert!(fs::symlink_metadata(&anchor).is_ok());
        assert!(fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@0.2.9"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structurally_invalid_lock_section_preserves_anchor() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let whale = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&whale).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters: []\n").unwrap();
        crate::service::core::create_directory_link(&whale.canonicalize().unwrap(), &anchor).unwrap();
        fs::remove_dir(&whale).unwrap();

        assert!(reconcile_at(&profile, &core).unwrap_err().contains("PLUGIN_UNINSTALL_LOCK_PARSE"));
        assert!(fs::symlink_metadata(&anchor).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_lock_without_required_identity_preserves_anchor_and_policy() {
        for content in ["foo: bar\n", "{}\n", "lockfileVersion: '9.0'\n", "importers: {}\n"] {
            let root = fixture_root();
            let profile = root.join("profile");
            let core = root.join("core");
            let whale = profile.join("node_modules/dsh-plugin-whale-pet");
            let anchor = core.join("node_modules/dsh-plugin-whale-pet");
            fs::create_dir_all(&whale).unwrap();
            fs::create_dir_all(anchor.parent().unwrap()).unwrap();
            fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
            fs::write(profile.join("pnpm-lock.yaml"), content).unwrap();
            fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
            crate::service::core::create_directory_link(&whale.canonicalize().unwrap(), &anchor).unwrap();
            fs::remove_dir(&whale).unwrap();

            assert!(reconcile_at(&profile, &core).unwrap_err().contains("PLUGIN_UNINSTALL_LOCK_PARSE"), "lock content: {content}");
            assert!(fs::symlink_metadata(&anchor).is_ok());
            assert!(fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@0.2.9"));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn partial_remove_keeps_anchor_until_lock_and_installed_files_are_absent() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        let policy = "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n";
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-plugin-whale-pet:\n        specifier: 0.2.9\n        version: 0.2.9\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), policy).unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor).unwrap();

        let error = cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap_err();
        assert!(error.contains("PLUGIN_UNINSTALL_STILL_LOCKED"), "{error}");
        assert!(fs::symlink_metadata(&anchor).is_ok());
        assert_eq!(fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap(), policy);

        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n").unwrap();
        let error = cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap_err();
        assert!(error.contains("PLUGIN_UNINSTALL_STILL_INSTALLED"), "{error}");
        assert!(fs::symlink_metadata(&anchor).is_ok());
        assert_eq!(fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap(), policy);

        fs::remove_dir(&plugin).unwrap();
        cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap();
        assert!(fs::symlink_metadata(&anchor).is_err());
        assert!(!fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_workspace_keeps_anchor_for_reconcile_retry() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude: [\n").unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor).unwrap();
        fs::remove_dir(&plugin).unwrap();

        let error = cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap_err();
        assert!(error.contains("PLUGIN_UNINSTALL_WORKSPACE_PARSE"), "{error}");
        assert!(fs::symlink_metadata(&anchor).is_ok());

        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
        assert_eq!(reconcile_at(&profile, &core).unwrap(), vec!["dsh-plugin-whale-pet"]);
        assert!(fs::symlink_metadata(&anchor).is_err());
        assert!(!fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap().contains("dsh-plugin-whale-pet@"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_workspace_state_keeps_anchor_for_reconcile_retry() {
        let root = fixture_root();
        let profile = root.join("profile");
        let core = root.join("core");
        let plugin = profile.join("node_modules/dsh-plugin-whale-pet");
        let anchor = core.join("node_modules/dsh-plugin-whale-pet");
        let state_path = profile.join("node_modules/.pnpm-workspace-state-v1.json");
        fs::create_dir_all(&plugin).unwrap();
        fs::create_dir_all(anchor.parent().unwrap()).unwrap();
        fs::write(profile.join("package.json"), r#"{"dependencies":{}}"#).unwrap();
        fs::write(profile.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n").unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "minimumReleaseAgeExclude:\n  - dsh-plugin-whale-pet@0.2.9\n").unwrap();
        fs::write(&state_path, "{").unwrap();
        crate::service::core::create_directory_link(&plugin.canonicalize().unwrap(), &anchor).unwrap();
        fs::remove_dir(&plugin).unwrap();

        let error = cleanup_at(&profile, Some(&core), "dsh-plugin-whale-pet").unwrap_err();
        assert!(error.contains("PLUGIN_UNINSTALL_WORKSPACE_STATE_PARSE"), "{error}");
        assert!(fs::symlink_metadata(&anchor).is_ok());

        fs::write(&state_path, r#"{"settings":{"minimumReleaseAgeExclude":["dsh-plugin-whale-pet@0.2.9"]}}"#).unwrap();
        assert_eq!(reconcile_at(&profile, &core).unwrap(), vec!["dsh-plugin-whale-pet"]);
        assert!(fs::symlink_metadata(&anchor).is_err());
        let state: serde_json::Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(state["settings"]["minimumReleaseAgeExclude"], serde_json::json!([]));
        fs::remove_dir_all(root).unwrap();
    }
}
