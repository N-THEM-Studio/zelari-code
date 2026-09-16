//! Process-wide memoization for the two hot CLI facts every command used to
//! recompute from scratch:
//!
//!   * the resolved entry point ([`crate::resolve_cli_entry_raw`]) — a
//!     canonicalize + walk-up filesystem probe, and
//!   * the `node <cli> --version` string — a full ~80–200 ms process spawn.
//!
//! Both ran on the Tauri main thread (sync commands), so app mount
//! (`--version`, `--doctor`, `--print-config`) and every run-finished
//! (`refreshCli`) froze the webview. A short TTL keeps the app responsive
//! while still noticing an upgrade within a minute; the explicit re-resolve
//! path (`update_cli` after `npm i -g`) calls [`invalidate`] so a freshly
//! installed CLI is never masked by a stale memo.
//!
//! Deliberately lock-light: the compute closure runs OUTSIDE the mutex (never
//! hold a std lock across filesystem/process I/O), and failures are never
//! cached so a transient miss (CLI not installed yet) is retried next call.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a memoized value stays fresh before the next caller recomputes it.
pub(crate) const TTL: Duration = Duration::from_secs(60);

/// Memo of the resolved CLI entry point + its version string, process-wide.
pub(crate) struct CliCache {
    entry: Mutex<Option<(PathBuf, Instant)>>,
    version: Mutex<Option<(String, Instant)>>,
}

impl CliCache {
    pub(crate) const fn new() -> Self {
        Self {
            entry: Mutex::new(None),
            version: Mutex::new(None),
        }
    }

    /// Return the memoized entry point while it is still fresh, otherwise
    /// recompute it with `compute` and cache the success.
    pub(crate) fn entry<F>(&self, compute: F) -> Result<PathBuf, String>
    where
        F: FnOnce() -> Result<PathBuf, String>,
    {
        {
            let guard = self.entry.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((path, at)) = guard.as_ref() {
                if at.elapsed() < TTL {
                    return Ok(path.clone());
                }
            }
        }
        let fresh = compute()?;
        {
            let mut guard = self.entry.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((fresh.clone(), Instant::now()));
        }
        Ok(fresh)
    }

    /// Same contract as [`CliCache::entry`] for the `--version` string.
    pub(crate) fn version<F>(&self, compute: F) -> Option<String>
    where
        F: FnOnce() -> Option<String>,
    {
        {
            let guard = self.version.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((v, at)) = guard.as_ref() {
                if at.elapsed() < TTL {
                    return Some(v.clone());
                }
            }
        }
        let fresh = compute()?;
        {
            let mut guard = self.version.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((fresh.clone(), Instant::now()));
        }
        Some(fresh)
    }

    /// Drop both memoized values. Call after installing/upgrading the CLI so
    /// the next command re-resolves the (possibly changed) entry/version.
    pub(crate) fn invalidate(&self) {
        *self.entry.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.version.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

static CLI_CACHE: CliCache = CliCache::new();

/// The process-wide CLI cache shared by every command.
pub(crate) fn get() -> &'static CliCache {
    &CLI_CACHE
}
