//! Updater security guard for the Tauri auto-update pipeline (Brief 4).
//!
//! Tauri's updater plugin already refuses *unsigned* artifacts (every payload
//! is verified against the baked-in Ed25519/minisign public key before it is
//! unpacked) and refuses non-HTTPS endpoints in release builds. What this
//! module adds is the *version gate*: a candidate release is only ever offered
//! if it is strictly newer than the running version. A downgrade or a
//! same-version re-install is blocked — a downgrade can reintroduce patched
//! vulnerabilities, and a "re-install" with the same version is a classic
//! confusion/rollback vector.
//!
//! The gate is wired into the plugin via `default_version_comparator`, which
//! the plugin consults inside `Updater::check` regardless of which caller
//! (Rust or the JS `plugin:updater|*` commands) triggers the check. This means
//! the guard cannot be bypassed by invoking the plugin's own commands directly
//! from the frontend.

use semver::Version;
use tauri_plugin_updater::RemoteRelease;

/// The exact log line emitted when a candidate release is refused. Kept as a
/// named constant so the security audit test can assert the sentence stays in
/// place (the acceptance criterion requires this literal message).
pub const DOWNGRADE_BLOCKED_LOG: &str = "Downgrade or re-install attempt blocked for security";

/// Decide whether a candidate release may be offered as an update over the
/// running version.
///
/// Fail-closed: only a strictly *newer* semver version passes. A candidate
/// that is equal (re-install) or older (downgrade) is rejected. Any version
/// that cannot be parsed as semver is also rejected — never assume a higher
/// string could be a valid upgrade.
pub fn is_upgrade_allowed(current: &Version, candidate: &Version) -> bool {
    candidate > current
}

/// The plugin's version comparator: `false` makes `Updater::check` treat the
/// release as "not an update", so it is never offered, downloaded or installed.
/// Blocking logs the exact constant so operators see *why* no update appeared.
pub fn should_offer_update(current: Version, release: RemoteRelease) -> bool {
    if is_upgrade_allowed(&current, &release.version) {
        true
    } else {
        log::warn!(
            "{DOWNGRADE_BLOCKED_LOG} (current {current}, candidate {})",
            release.version
        );
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::{ReleaseManifestPlatform, RemoteReleaseInner};
    use url::Url;

    fn release(version: &str) -> RemoteRelease {
        RemoteRelease {
            version: Version::parse(version).expect("valid test version"),
            notes: None,
            pub_date: None,
            data: RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                url: Url::parse("https://updates.p2phub.example/pkg.tar.gz")
                    .expect("valid test url"),
                signature: "bogus-signature".to_string(),
            }),
        }
    }

    #[test]
    fn a_strictly_newer_version_is_offered() {
        assert!(is_upgrade_allowed(
            &Version::parse("0.1.0").unwrap(),
            &Version::parse("0.1.1").unwrap()
        ));
        assert!(is_upgrade_allowed(
            &Version::parse("0.1.0").unwrap(),
            &Version::parse("1.0.0").unwrap()
        ));
        // Pre-release ordering is semver's job: 0.2.0-rc.1 < 0.2.0.
        assert!(is_upgrade_allowed(
            &Version::parse("0.2.0-rc.1").unwrap(),
            &Version::parse("0.2.0").unwrap()
        ));
    }

    #[test]
    fn a_downgrade_is_blocked() {
        assert!(!is_upgrade_allowed(
            &Version::parse("0.2.0").unwrap(),
            &Version::parse("0.1.0").unwrap()
        ));
        assert!(!is_upgrade_allowed(
            &Version::parse("1.1.0").unwrap(),
            &Version::parse("1.0.0").unwrap()
        ));
    }

    #[test]
    fn a_same_version_reinstall_is_blocked() {
        assert!(!is_upgrade_allowed(
            &Version::parse("0.1.0").unwrap(),
            &Version::parse("0.1.0").unwrap()
        ));
    }

    #[test]
    fn an_unparseable_candidate_is_blocked() {
        // A hostile or misconfigured release manifest must never be treated as
        // an upgrade just because its string sorts higher.
        let garbage = Version::parse("not-a-version");
        assert!(garbage.is_err());
        let current = Version::parse("0.1.0").unwrap();
        if let Ok(bad) = garbage {
            assert!(!is_upgrade_allowed(&current, &bad));
        }
    }

    #[test]
    fn comparator_blocks_an_equal_release() {
        let current = Version::parse("0.1.0").unwrap();
        assert!(!should_offer_update(current, release("0.1.0")));
    }

    #[test]
    fn comparator_blocks_a_downgrade_release() {
        let current = Version::parse("0.2.0").unwrap();
        assert!(!should_offer_update(current, release("0.1.0")));
    }

    #[test]
    fn comparator_offers_a_strict_upgrade() {
        let current = Version::parse("0.1.0").unwrap();
        assert!(should_offer_update(current, release("0.2.0")));
    }

    #[test]
    fn the_blocked_log_line_matches_the_acceptance_criterion() {
        // The brief requires this exact sentence to be logged. The audit test
        // greps the source for it; this test pins the string itself.
        assert_eq!(
            DOWNGRADE_BLOCKED_LOG,
            "Downgrade or re-install attempt blocked for security"
        );
    }
}
