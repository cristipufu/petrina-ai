//! Atomic versioned engine release pointer resolution and rollback for the desktop host.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReleaseKind {
    Binary,
    Bun,
}

impl ReleaseKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Bun => "bun",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "binary" => Some(Self::Binary),
            "bun" => Some(Self::Bun),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReleasePointer {
    pub(crate) version: String,
    pub(crate) entrypoint: PathBuf,
    pub(crate) kind: ReleaseKind,
    pub(crate) promoted_at: u64,
}

pub(crate) fn petrina_home() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PETRINA_HOME") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(home_var)
        .filter(|val| !val.is_empty())
        .map(|val| PathBuf::from(val).join(".petrina"))
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 80
        && !version.contains("..")
        && version
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

pub(crate) fn error_line_blocks_rollback(hello: &str) -> bool {
    hello.contains("intentionally stopped")
        || hello.contains("handoff is still in progress")
        || hello.contains("holds this folder")
}

fn skip_ws(bytes: &[u8], mut idx: usize) -> usize {
    while idx < bytes.len() && matches!(bytes[idx], b' ' | b'\t' | b'\r' | b'\n') {
        idx += 1;
    }
    idx
}

fn parse_json_string(raw: &str, start: usize) -> Option<(String, usize)> {
    let bytes = raw.as_bytes();
    if bytes.get(start).copied() != Some(b'"') {
        return None;
    }
    let mut idx = start + 1;
    let mut out = String::new();
    while idx < bytes.len() {
        let ch = bytes[idx];
        if ch == b'"' {
            return Some((out, idx + 1));
        }
        if ch == b'\\' {
            idx += 1;
            let esc = *bytes.get(idx)?;
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000C}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let hex = raw.get(idx + 1..idx + 5)?;
                    let code = u32::from_str_radix(hex, 16).ok()?;
                    out.push(char::from_u32(code)?);
                    idx += 4;
                }
                _ => return None,
            }
            idx += 1;
        } else {
            let rest = raw.get(idx..)?;
            let next_char = rest.chars().next()?;
            if next_char.is_control() {
                return None;
            }
            out.push(next_char);
            idx += next_char.len_utf8();
        }
    }
    None
}

fn parse_json_u64(raw: &str, start: usize) -> Option<(u64, usize)> {
    let bytes = raw.as_bytes();
    let mut idx = start;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == start {
        return None;
    }
    let value = raw.get(start..idx)?.parse::<u64>().ok()?;
    Some((value, idx))
}

fn parse_pointer_json(raw: &str) -> Option<ReleasePointer> {
    let bytes = raw.as_bytes();
    let mut idx = skip_ws(bytes, 0);
    if bytes.get(idx).copied() != Some(b'{') {
        return None;
    }
    idx = skip_ws(bytes, idx + 1);

    let mut version: Option<String> = None;
    let mut entrypoint: Option<String> = None;
    let mut kind: Option<ReleaseKind> = None;
    let mut promoted_at: Option<u64> = None;

    if bytes.get(idx).copied() == Some(b'}') {
        return None;
    }

    loop {
        let (key, after_key) = parse_json_string(raw, idx)?;
        idx = skip_ws(bytes, after_key);
        if bytes.get(idx).copied() != Some(b':') {
            return None;
        }
        idx = skip_ws(bytes, idx + 1);

        match key.as_str() {
            "version" => {
                let (val, next) = parse_json_string(raw, idx)?;
                version = Some(val);
                idx = next;
            }
            "entrypoint" => {
                let (val, next) = parse_json_string(raw, idx)?;
                entrypoint = Some(val);
                idx = next;
            }
            "kind" => {
                let (val, next) = parse_json_string(raw, idx)?;
                kind = Some(ReleaseKind::from_str(&val)?);
                idx = next;
            }
            "promotedAt" => {
                let (val, next) = parse_json_u64(raw, idx)?;
                promoted_at = Some(val);
                idx = next;
            }
            _ => return None,
        }

        idx = skip_ws(bytes, idx);
        match bytes.get(idx).copied() {
            Some(b',') => {
                idx = skip_ws(bytes, idx + 1);
            }
            Some(b'}') => {
                idx = skip_ws(bytes, idx + 1);
                break;
            }
            _ => return None,
        }
    }

    if idx != bytes.len() {
        return None;
    }

    let version = version?;
    if !valid_version(&version) {
        return None;
    }
    Some(ReleasePointer {
        version,
        entrypoint: PathBuf::from(entrypoint?),
        kind: kind?,
        promoted_at: promoted_at?,
    })
}

fn escape_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn format_pointer_json(pointer: &ReleasePointer) -> String {
    let entry = pointer.entrypoint.to_string_lossy();
    format!(
        "{{\n  \"version\": {},\n  \"entrypoint\": {},\n  \"kind\": {},\n  \"promotedAt\": {}\n}}\n",
        escape_json_string(&pointer.version),
        escape_json_string(&entry),
        escape_json_string(pointer.kind.as_str()),
        pointer.promoted_at
    )
}

fn validate_on_disk(home: &Path, mut pointer: ReleasePointer) -> Option<ReleasePointer> {
    let versions_dir = fs::canonicalize(home.join("releases").join("versions")).ok()?;
    let canonical_entry = fs::canonicalize(&pointer.entrypoint).ok()?;
    if !canonical_entry.starts_with(&versions_dir)
        || canonical_entry == versions_dir
        || !canonical_entry.is_file()
    {
        return None;
    }
    pointer.entrypoint = canonical_entry;
    Some(pointer)
}

fn read_pointer_file(home: &Path, name: &str) -> Option<ReleasePointer> {
    let path = home.join("releases").join(name);
    let raw = fs::read_to_string(path).ok()?;
    let parsed = parse_pointer_json(&raw)?;
    validate_on_disk(home, parsed)
}

pub(crate) fn read_current(home: &Path) -> Option<ReleasePointer> {
    read_pointer_file(home, "current")
}

pub(crate) fn read_previous(home: &Path) -> Option<ReleasePointer> {
    read_pointer_file(home, "previous")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn write_pointer_atomic(
    home: &Path,
    name: &str,
    pointer: &ReleasePointer,
) -> Result<(), String> {
    let releases_dir = home.join("releases");
    fs::create_dir_all(&releases_dir).map_err(|err| err.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_nanos())
        .unwrap_or(0);
    let temp_path = releases_dir.join(format!(".tmp-{name}-{}-{nonce}", std::process::id()));
    let target_path = releases_dir.join(name);
    let body = format_pointer_json(pointer);
    let write_result = (|| -> Result<(), String> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp_path).map_err(|err| err.to_string())?;
        file.write_all(body.as_bytes())
            .map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
        drop(file);
        fs::rename(&temp_path, &target_path).map_err(|err| err.to_string())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

pub(crate) fn rollback_to_previous(home: &Path) -> Result<ReleasePointer, String> {
    let mut previous = read_previous(home).ok_or_else(|| {
        "No previous verified engine release is available for rollback.".to_string()
    })?;
    previous.promoted_at = now_millis();
    write_pointer_atomic(home, "current", &previous)?;
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "petrina-rust-release-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(dir.join("releases").join("versions")).unwrap();
        dir
    }

    #[test]
    fn parses_serde_json_release_pointers_and_rejects_traversal_or_unknown_fields() {
        let home = temp_home("parse");
        let v1_dir = home.join("releases").join("versions").join("1.2.0");
        fs::create_dir_all(&v1_dir).unwrap();
        let entry = v1_dir.join("cli.ts");
        fs::write(&entry, "// v1\n").unwrap();

        let raw = serde_json::json!({
            "version": "1.2.0",
            "entrypoint": entry.to_string_lossy(),
            "kind": "bun",
            "promotedAt": 1_700_000_123_456_u64
        })
        .to_string();

        fs::write(home.join("releases").join("current"), &raw).unwrap();
        let loaded = read_current(&home).expect("valid pointer loads");
        assert_eq!(loaded.version, "1.2.0");
        assert_eq!(loaded.kind, ReleaseKind::Bun);
        assert_eq!(loaded.promoted_at, 1_700_000_123_456);
        assert_eq!(loaded.entrypoint, fs::canonicalize(&entry).unwrap());

        // Round-trip formatted JSON through serde_json and parse_pointer_json.
        let formatted = format_pointer_json(&loaded);
        let serde_val: serde_json::Value = serde_json::from_str(&formatted).unwrap();
        assert_eq!(serde_val["version"], "1.2.0");
        assert_eq!(parse_pointer_json(&formatted).unwrap().version, "1.2.0");

        // Reject path outside releases/versions/.
        let outside = home.join("outside.ts");
        fs::write(&outside, "// outside\n").unwrap();
        let escaped = serde_json::json!({
            "version": "1.2.0",
            "entrypoint": outside.to_string_lossy(),
            "kind": "bun",
            "promotedAt": 1
        })
        .to_string();
        fs::write(home.join("releases").join("current"), escaped).unwrap();
        assert!(read_current(&home).is_none());

        // Reject path traversal version identifiers and unknown JSON properties.
        assert!(!valid_version("../evil"));
        assert!(!valid_version(".hidden"));
        assert!(parse_pointer_json(
            r#"{"version":"1.0.0","entrypoint":"/x","kind":"binary","promotedAt":1,"extra":true}"#
        )
        .is_none());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn atomically_restores_current_pointer_from_previous() {
        let home = temp_home("rollback");
        let v1_dir = home.join("releases").join("versions").join("1.0.0");
        let v2_dir = home.join("releases").join("versions").join("2.0.0");
        fs::create_dir_all(&v1_dir).unwrap();
        fs::create_dir_all(&v2_dir).unwrap();
        let v1_bin = v1_dir.join("petrina-engine");
        let v2_bin = v2_dir.join("petrina-engine");
        fs::write(&v1_bin, "v1").unwrap();
        fs::write(&v2_bin, "v2").unwrap();

        let p1 = ReleasePointer {
            version: "1.0.0".into(),
            entrypoint: v1_bin.clone(),
            kind: ReleaseKind::Binary,
            promoted_at: 100,
        };
        let p2 = ReleasePointer {
            version: "2.0.0".into(),
            entrypoint: v2_bin,
            kind: ReleaseKind::Binary,
            promoted_at: 200,
        };
        write_pointer_atomic(&home, "previous", &p1).unwrap();
        write_pointer_atomic(&home, "current", &p2).unwrap();
        assert_eq!(read_current(&home).unwrap().version, "2.0.0");

        let restored = rollback_to_previous(&home).unwrap();
        assert_eq!(restored.version, "1.0.0");
        assert_eq!(read_current(&home).unwrap().version, "1.0.0");
        assert_eq!(
            read_current(&home).unwrap().entrypoint,
            fs::canonicalize(&v1_bin).unwrap()
        );

        let _ = fs::remove_dir_all(&home);
    }
}
