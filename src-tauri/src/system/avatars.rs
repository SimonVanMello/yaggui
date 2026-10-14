//! Gravatar avatars (F-033): download and disk cache.
//!
//! Not a Git operation, so it lives here and not in `git/`. Only the SHA-256 of the e-mail
//! ever leaves the app, over HTTPS, without referrer. The frontend asks for one hash at a
//! time; this module answers from the cache folder when it can:
//!
//! - `<hash>` holds the image, `<hash>.none` is an empty marker for "Gravatar has no image"
//!   (`d=404`), so a missing address is not asked again on every render;
//! - entries expire from their modification time (`Limits::ttl`, `Limits::missing_ttl`); an
//!   expired image is still served when the refresh fails (offline);
//! - the folder is bounded in bytes and in entries, the oldest entries go first;
//! - concurrent requests for the same hash share one download, and the downloads in flight
//!   are bounded.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use crate::git::errors::YagguiError;

/// Side of the square asked for, in pixels: twice the avatar (`--icon-size-lg`) for
/// high-density screens. Part of the cached content: change it with `CACHE_VERSION`.
pub const AVATAR_SIZE: u32 = 40;

/// Sub-folder of the cache folder; the version is bumped when the cached content changes
/// (size, URL parameters) so old files are simply ignored.
pub const CACHE_FOLDER: &str = "avatars-v1";

/// A 40 px avatar weighs a few KB; anything bigger is not what we asked for.
const MAX_IMAGE_BYTES: u64 = 256 * 1024;

const MISSING_SUFFIX: &str = ".none";

/// What Gravatar answers for a hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    Image(Vec<u8>),
    /// No Gravatar for this address (HTTP 404 with `d=404`).
    Missing,
}

/// Where images come from. The real one is [`HttpTransport`]; tests use a fake.
pub trait Transport: Send + Sync {
    fn fetch(&self, hash: &str) -> Result<Fetched, YagguiError>;
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Lifetime of an image.
    pub ttl: Duration,
    /// Lifetime of a "no Gravatar" marker: shorter, the user may create one.
    pub missing_ttl: Duration,
    pub max_bytes: u64,
    pub max_entries: usize,
    /// Downloads running at the same time.
    pub max_in_flight: usize,
    /// The folder is scanned every this many writes, not on each one.
    pub prune_every: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(7 * 24 * 3600),
            missing_ttl: Duration::from_secs(2 * 24 * 3600),
            max_bytes: 20 * 1024 * 1024,
            max_entries: 10_000,
            max_in_flight: 4,
            prune_every: 32,
        }
    }
}

type Outcome = Result<Option<Vec<u8>>, YagguiError>;

/// One download that several callers wait for.
struct Flight {
    outcome: Mutex<Option<Outcome>>,
    done: Condvar,
}

/// Counting semaphore bounding the downloads in flight.
struct Gate {
    free: Mutex<usize>,
    available: Condvar,
}

struct Permit<'a>(&'a Gate);

impl Gate {
    fn acquire(&self) -> Permit<'_> {
        let mut free = lock(&self.free);
        while *free == 0 {
            free = self
                .available
                .wait(free)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *free -= 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *lock(&self.0.free) += 1;
        self.0.available.notify_one();
    }
}

/// Settles the flight of a hash when dropped, even if the download panicked, so no waiter
/// is left hanging.
struct Leader<'a> {
    cache: &'a AvatarCache,
    hash: &'a str,
    flight: Arc<Flight>,
    outcome: Option<Outcome>,
}

impl Drop for Leader<'_> {
    fn drop(&mut self) {
        let outcome = self
            .outcome
            .take()
            .unwrap_or_else(|| Err(YagguiError::internal("avatar download aborted")));
        *lock(&self.flight.outcome) = Some(outcome);
        self.flight.done.notify_all();
        lock(&self.cache.flights).remove(self.hash);
    }
}

pub struct AvatarCache {
    dir: PathBuf,
    transport: Arc<dyn Transport>,
    limits: Limits,
    flights: Mutex<HashMap<String, Arc<Flight>>>,
    gate: Gate,
    writes: AtomicU32,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere must not take the avatars down with it: the guarded data stays valid.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A hash is the hex SHA-256 of the e-mail: it becomes a file name and part of a URL, so
/// nothing else gets through.
pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl AvatarCache {
    pub fn new(dir: PathBuf, transport: Arc<dyn Transport>, limits: Limits) -> Self {
        Self {
            dir,
            transport,
            gate: Gate {
                free: Mutex::new(limits.max_in_flight.max(1)),
                available: Condvar::new(),
            },
            limits,
            flights: Mutex::new(HashMap::new()),
            writes: AtomicU32::new(0),
        }
    }

    /// The image for `hash`, `None` when Gravatar has none. Served from the disk when fresh;
    /// otherwise downloaded (once, however many callers ask) and stored.
    pub fn get(&self, hash: &str) -> Outcome {
        if !is_valid_hash(hash) {
            return Err(YagguiError::invalid_argument(
                "Invalid avatar hash.",
                "Hash d'avatar invalide.",
            ));
        }
        if let Some(entry) = self.read(hash, false) {
            return Ok(entry);
        }
        let (flight, leading) = {
            let mut flights = lock(&self.flights);
            match flights.get(hash) {
                Some(flight) => (Arc::clone(flight), false),
                None => {
                    let flight = Arc::new(Flight {
                        outcome: Mutex::new(None),
                        done: Condvar::new(),
                    });
                    flights.insert(hash.to_owned(), Arc::clone(&flight));
                    (flight, true)
                }
            }
        };
        if !leading {
            let mut outcome = lock(&flight.outcome);
            while outcome.is_none() {
                outcome = flight
                    .done
                    .wait(outcome)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            return outcome.clone().unwrap_or(Ok(None));
        }
        let mut leader = Leader {
            cache: self,
            hash,
            flight,
            outcome: None,
        };
        let outcome = self.refresh(hash);
        leader.outcome = Some(outcome.clone());
        drop(leader);
        outcome
    }

    fn refresh(&self, hash: &str) -> Outcome {
        let _permit = self.gate.acquire();
        // Another caller may have stored it between the first look and the flight.
        if let Some(entry) = self.read(hash, false) {
            return Ok(entry);
        }
        match self.transport.fetch(hash) {
            Ok(fetched) => {
                let entry = match fetched {
                    Fetched::Image(bytes) => Some(bytes),
                    Fetched::Missing => None,
                };
                self.store(hash, entry.as_deref());
                Ok(entry)
            }
            Err(err) => {
                tracing::warn!(error = %err, "avatar download failed");
                // Offline: an expired image beats no image. Failures are not cached.
                self.read(hash, true).ok_or(err)
            }
        }
    }

    /// `Some(entry)` when the disk has an answer for `hash`: an image (`Some(Some)`), or a
    /// marker (`Some(None)`). Expired entries only count with `stale`.
    fn read(&self, hash: &str, stale: bool) -> Option<Option<Vec<u8>>> {
        let image = self.dir.join(hash);
        if let Some(age) = age(&image)
            && (stale || age <= self.limits.ttl)
            && let Ok(bytes) = fs::read(&image)
        {
            return Some(Some(bytes));
        }
        let marker = self.dir.join(format!("{hash}{MISSING_SUFFIX}"));
        match age(&marker) {
            Some(age) if age <= self.limits.missing_ttl => Some(None),
            _ => None,
        }
    }

    /// Cache write errors are logged, not returned: the answer is good, only the next
    /// request will pay for the download again.
    fn store(&self, hash: &str, image: Option<&[u8]>) {
        if let Err(err) = self.write_entry(hash, image) {
            tracing::warn!(error = %err, "cannot write the avatar cache");
            return;
        }
        let writes = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
        if writes.is_multiple_of(self.limits.prune_every.max(1)) {
            self.prune();
        }
    }

    fn write_entry(&self, hash: &str, image: Option<&[u8]>) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let marker = self.dir.join(format!("{hash}{MISSING_SUFFIX}"));
        let file = self.dir.join(hash);
        match image {
            Some(bytes) => {
                // Written aside then renamed: a crash never leaves a truncated image.
                let partial = self.dir.join(format!("{hash}.tmp"));
                fs::write(&partial, bytes)?;
                fs::rename(&partial, &file)?;
                remove_if_exists(&marker)
            }
            None => {
                fs::write(&marker, b"")?;
                remove_if_exists(&file)
            }
        }
    }

    /// Drops expired entries, then the oldest ones until the folder fits its bounds.
    /// Returns the number of files removed.
    pub fn prune(&self) -> usize {
        let Ok(listing) = fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut entries: Vec<(PathBuf, u64, Duration)> = listing
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                meta.is_file().then(|| {
                    let age = meta
                        .modified()
                        .ok()
                        .and_then(|m| SystemTime::now().duration_since(m).ok())
                        .unwrap_or_default();
                    (entry.path(), meta.len(), age)
                })
            })
            .collect();
        let mut removed = 0;
        entries.retain(|(path, _, age)| {
            let limit = if is_marker(path) {
                self.limits.missing_ttl
            } else {
                self.limits.ttl
            };
            if *age > limit {
                removed += usize::from(remove_if_exists(path).is_ok());
                false
            } else {
                true
            }
        });
        // Oldest first.
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.2));
        let mut bytes: u64 = entries.iter().map(|e| e.1).sum();
        let mut count = entries.len();
        for (path, size, _) in &entries {
            if bytes <= self.limits.max_bytes && count <= self.limits.max_entries {
                break;
            }
            if remove_if_exists(path).is_ok() {
                removed += 1;
                bytes = bytes.saturating_sub(*size);
                count -= 1;
            }
        }
        if removed > 0 {
            tracing::debug!(removed, "avatar cache pruned");
        }
        removed
    }

    /// Empties the cache (preferences). Returns the number of files removed.
    pub fn clear(&self) -> Result<usize, YagguiError> {
        let listing = match fs::read_dir(&self.dir) {
            Ok(listing) => listing,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(err) => return Err(YagguiError::storage(err.to_string())),
        };
        let mut removed = 0;
        for entry in listing.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_file() {
                remove_if_exists(&path).map_err(|err| YagguiError::storage(err.to_string()))?;
                removed += 1;
            }
        }
        tracing::info!(removed, "avatar cache cleared");
        Ok(removed)
    }
}

fn is_marker(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "none")
}

fn age(path: &Path) -> Option<Duration> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    // A clock set back counts as brand new rather than as expired.
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default(),
    )
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Real transport: Gravatar over HTTPS. Blocking, so callers run it off the async runtime.
pub struct HttpTransport {
    agent: ureq::Agent,
}

impl HttpTransport {
    pub fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .https_only(true)
            // A status other than 200 is an answer to interpret, not a transport error.
            .http_status_as_error(false)
            .user_agent(concat!("yaggui/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Self { agent }
    }
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for HttpTransport {
    fn fetch(&self, hash: &str) -> Result<Fetched, YagguiError> {
        // `d=404`: no generated image, the initials stay when the address has no Gravatar.
        // ureq sends no `Referer`.
        let url = format!("https://www.gravatar.com/avatar/{hash}?s={AVATAR_SIZE}&d=404");
        let mut response = self
            .agent
            .get(&url)
            .call()
            .map_err(|err| YagguiError::avatar_unavailable(err.to_string()))?;
        match response.status().as_u16() {
            200 => {
                let bytes = response
                    .body_mut()
                    .with_config()
                    .limit(MAX_IMAGE_BYTES)
                    .read_to_vec()
                    .map_err(|err| YagguiError::avatar_unavailable(err.to_string()))?;
                if image_mime(&bytes).is_none() {
                    return Err(YagguiError::avatar_unavailable("not an image"));
                }
                Ok(Fetched::Image(bytes))
            }
            404 => Ok(Fetched::Missing),
            status => Err(YagguiError::avatar_unavailable(format!("HTTP {status}"))),
        }
    }
}

/// Media type from the magic bytes. Only raster formats: an SVG (scriptable) is refused.
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// `data:` URL of an image: allowed by the CSP (`img-src data:`) without opening any remote
/// origin. `None` for bytes that are not a known raster image.
pub fn data_url(bytes: &[u8]) -> Option<String> {
    let mime = image_mime(bytes)?;
    Some(format!("data:{mime};base64,{}", base64(bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> shift & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    fn hash(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    /// Answers from a script and counts the calls; `delay` makes concurrent callers overlap.
    struct Fake {
        calls: AtomicUsize,
        in_flight: AtomicUsize,
        peak: AtomicUsize,
        delay: Duration,
        answer: Mutex<Result<Fetched, YagguiError>>,
    }

    impl Fake {
        fn new(answer: Result<Fetched, YagguiError>) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                in_flight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                delay: Duration::ZERO,
                answer: Mutex::new(answer),
            })
        }

        fn slow(answer: Fetched, delay: Duration) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                in_flight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                delay,
                answer: Mutex::new(Ok(answer)),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn set(&self, answer: Result<Fetched, YagguiError>) {
            *lock(&self.answer) = answer;
        }
    }

    impl Transport for Fake {
        fn fetch(&self, _hash: &str) -> Result<Fetched, YagguiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            lock(&self.answer).clone()
        }
    }

    fn cache(fake: &Arc<Fake>, limits: Limits) -> (tempfile::TempDir, AvatarCache) {
        let dir = tempfile::tempdir().expect("temp dir");
        let transport: Arc<dyn Transport> = fake.clone();
        let cache = AvatarCache::new(dir.path().join(CACHE_FOLDER), transport, limits);
        (dir, cache)
    }

    fn age_file(cache: &AvatarCache, name: &str, by: Duration) {
        let file = fs::File::options()
            .write(true)
            .open(cache.dir.join(name))
            .expect("open cache file");
        file.set_modified(SystemTime::now() - by)
            .expect("set mtime");
    }

    #[test]
    fn rejects_anything_but_a_sha256_hash() {
        let fake = Fake::new(Ok(Fetched::Missing));
        let (_dir, cache) = cache(&fake, Limits::default());
        for bad in [
            "",
            "abc",
            "../../etc/passwd",
            &"G".repeat(64),
            &"A".repeat(64),
        ] {
            assert!(cache.get(bad).is_err(), "{bad}");
        }
        assert_eq!(fake.calls(), 0);
    }

    #[test]
    fn serves_the_second_request_from_the_disk() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let (_dir, cache) = cache(&fake, Limits::default());
        assert_eq!(cache.get(&hash(1)), Ok(Some(PNG.to_vec())));
        assert_eq!(cache.get(&hash(1)), Ok(Some(PNG.to_vec())));
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn expired_images_are_downloaded_again() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let (_dir, cache) = cache(&fake, Limits::default());
        let h = hash(2);
        cache.get(&h).expect("first");
        age_file(&cache, &h, cache.limits.ttl + Duration::from_secs(60));
        cache.get(&h).expect("second");
        assert_eq!(fake.calls(), 2);
        // The refresh renewed it.
        cache.get(&h).expect("third");
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn an_expired_image_is_served_when_offline() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let (_dir, cache) = cache(&fake, Limits::default());
        let h = hash(3);
        cache.get(&h).expect("first");
        age_file(&cache, &h, cache.limits.ttl * 2);
        fake.set(Err(YagguiError::avatar_unavailable("offline")));
        assert_eq!(cache.get(&h), Ok(Some(PNG.to_vec())));
    }

    #[test]
    fn failures_are_not_cached() {
        let fake = Fake::new(Err(YagguiError::avatar_unavailable("offline")));
        let (_dir, cache) = cache(&fake, Limits::default());
        let h = hash(4);
        assert!(cache.get(&h).is_err());
        fake.set(Ok(Fetched::Image(PNG.to_vec())));
        assert_eq!(cache.get(&h), Ok(Some(PNG.to_vec())));
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn a_missing_gravatar_is_cached_negatively_then_expires() {
        let fake = Fake::new(Ok(Fetched::Missing));
        let (_dir, cache) = cache(&fake, Limits::default());
        let h = hash(5);
        assert_eq!(cache.get(&h), Ok(None));
        assert_eq!(cache.get(&h), Ok(None));
        assert_eq!(fake.calls(), 1);
        assert!(cache.dir.join(format!("{h}{MISSING_SUFFIX}")).exists());

        age_file(
            &cache,
            &format!("{h}{MISSING_SUFFIX}"),
            cache.limits.missing_ttl + Duration::from_secs(60),
        );
        fake.set(Ok(Fetched::Image(PNG.to_vec())));
        assert_eq!(cache.get(&h), Ok(Some(PNG.to_vec())));
        assert_eq!(fake.calls(), 2);
        assert!(!cache.dir.join(format!("{h}{MISSING_SUFFIX}")).exists());
    }

    #[test]
    fn eviction_drops_the_oldest_entries_first() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let limits = Limits {
            max_entries: 3,
            prune_every: 1,
            ..Limits::default()
        };
        let (_dir, cache) = cache(&fake, limits);
        for n in 0..3 {
            cache.get(&hash(n)).expect("fill");
            // Distinct, increasing ages: hash(0) is the oldest.
            age_file(
                &cache,
                &hash(n),
                Duration::from_secs(1000 - u64::from(n) * 100),
            );
        }
        cache.get(&hash(9)).expect("overflow");
        assert!(!cache.dir.join(hash(0)).exists(), "oldest evicted");
        assert!(cache.dir.join(hash(1)).exists());
        assert!(cache.dir.join(hash(2)).exists());
        assert!(cache.dir.join(hash(9)).exists());
    }

    #[test]
    fn eviction_also_bounds_the_size() {
        let fake = Fake::new(Ok(Fetched::Image(vec![0x89; 10])));
        let limits = Limits {
            max_bytes: 25,
            prune_every: 1,
            ..Limits::default()
        };
        // 10 bytes each, but not PNG magic: write straight through the cache internals.
        let (_dir, cache) = cache(&fake, limits);
        for n in 0..3 {
            cache.store(&hash(n), Some(&[0; 10]));
            age_file(
                &cache,
                &hash(n),
                Duration::from_secs(1000 - u64::from(n) * 100),
            );
        }
        cache.prune();
        assert!(!cache.dir.join(hash(0)).exists());
        assert!(cache.dir.join(hash(1)).exists());
        assert!(cache.dir.join(hash(2)).exists());
    }

    #[test]
    fn prune_removes_expired_entries() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let (_dir, cache) = cache(&fake, Limits::default());
        cache.get(&hash(1)).expect("image");
        age_file(&cache, &hash(1), cache.limits.ttl + Duration::from_secs(60));
        cache.get(&hash(2)).expect("fresh");
        assert_eq!(cache.prune(), 1);
        assert!(!cache.dir.join(hash(1)).exists());
        assert!(cache.dir.join(hash(2)).exists());
    }

    #[test]
    fn concurrent_requests_share_one_download() {
        let fake = Fake::slow(Fetched::Image(PNG.to_vec()), Duration::from_millis(100));
        let (_dir, cache) = cache(&fake, Limits::default());
        let h = hash(6);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| cache.get(&h))).collect();
            for handle in handles {
                assert_eq!(handle.join().expect("thread"), Ok(Some(PNG.to_vec())));
            }
        });
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn downloads_in_flight_are_bounded() {
        let fake = Fake::slow(Fetched::Missing, Duration::from_millis(50));
        let limits = Limits {
            max_in_flight: 2,
            ..Limits::default()
        };
        let (_dir, cache) = cache(&fake, limits);
        std::thread::scope(|scope| {
            for n in 0..8 {
                let cache = &cache;
                scope.spawn(move || cache.get(&hash(n)));
            }
        });
        assert_eq!(fake.calls(), 8);
        assert!(fake.peak.load(Ordering::SeqCst) <= 2);
    }

    #[test]
    fn clear_empties_the_cache_and_forces_a_new_download() {
        let fake = Fake::new(Ok(Fetched::Image(PNG.to_vec())));
        let (_dir, cache) = cache(&fake, Limits::default());
        assert_eq!(cache.clear(), Ok(0), "no folder yet");
        cache.get(&hash(1)).expect("image");
        fake.set(Ok(Fetched::Missing));
        cache.get(&hash(2)).expect("marker");
        assert_eq!(cache.clear(), Ok(2));
        cache.get(&hash(1)).expect("again");
        assert_eq!(fake.calls(), 3);
    }

    #[test]
    fn data_urls_are_base64_of_known_images_only() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        let url = data_url(PNG).expect("png");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(data_url(b"<svg onload=alert(1)>").is_none());
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
    }
}
