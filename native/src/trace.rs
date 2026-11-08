//! Passive, bounded phase recording. Event handlers only serialize and try-send.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RECORD_BYTES: usize = 2 * 1024;
const BUFFER_LINES: usize = 128;
const MAP_ENTRIES: usize = 256;
const FILE_BYTES: usize = 8 * 1024 * 1024;
const FLUSH_WAIT: Duration = Duration::from_millis(250);
const MAX_RAW_ID_BYTES: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Header,
    SessionStart,
    ProcessEnd,
    RunStart,
    TurnStart,
    RequestStart,
    FirstProviderEvent,
    FirstText,
    FirstReasoning,
    FirstTool,
    MessageEnd,
    ToolStart,
    ToolEnd,
    CancelRequested,
    BeforeSettle,
    Settled,
    RecordingGap,
}
impl Kind {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "run_start" => Self::RunStart,
            "turn_start" => Self::TurnStart,
            "request_start" => Self::RequestStart,
            "first_provider_event" => Self::FirstProviderEvent,
            "first_text" => Self::FirstText,
            "first_reasoning" => Self::FirstReasoning,
            "first_tool" => Self::FirstTool,
            "message_end" => Self::MessageEnd,
            "tool_start" => Self::ToolStart,
            "tool_end" => Self::ToolEnd,
            "cancel_requested" => Self::CancelRequested,
            "before_settle" => Self::BeforeSettle,
            "settled" => Self::Settled,
            "recording_gap" => Self::RecordingGap,
            _ => return None,
        })
    }
    fn first(self) -> bool {
        matches!(
            self,
            Self::FirstProviderEvent | Self::FirstText | Self::FirstReasoning | Self::FirstTool
        )
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Ok,
    Error,
    Aborted,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Gap {
    UnknownCorrelation,
    FileLimit,
    RecordLimit,
    QueueFull,
    WriteFailed,
    FlushTimeout,
}
impl Gap {
    fn label(self) -> &'static str {
        match self {
            Self::UnknownCorrelation => "unknown_correlation",
            Self::FileLimit => "file_limit",
            Self::RecordLimit => "record_limit",
            Self::QueueFull => "queue_full",
            Self::WriteFailed => "write_failed",
            Self::FlushTimeout => "flush_timeout",
        }
    }
}
#[derive(Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_write: Option<u64>,
}
#[derive(Default)]
struct Input {
    tool_id: Option<String>,
    outcome: Option<Outcome>,
    usage: Option<Usage>,
}
impl Input {
    fn from_value(value: Value) -> Self {
        let tool_id = value
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= MAX_RAW_ID_BYTES)
            .map(str::to_owned);
        let outcome = match value.get("outcome").and_then(Value::as_str) {
            Some("ok") => Some(Outcome::Ok),
            Some("error") => Some(Outcome::Error),
            Some("aborted") => Some(Outcome::Aborted),
            _ => None,
        };
        let usage = value
            .get("usage")
            .filter(|usage| usage.is_object())
            .map(|usage| {
                let number = |key| {
                    usage
                        .get(key)
                        .and_then(Value::as_u64)
                        .filter(|n| *n <= MAX_SAFE_INTEGER)
                };
                Usage {
                    input: number("input"),
                    output: number("output"),
                    cache_read: number("cacheRead"),
                    cache_write: number("cacheWrite"),
                }
            });
        Self {
            tool_id,
            outcome,
            usage,
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    schema_version: u8,
    event: Kind,
    seq: u64,
    segment: u64,
    elapsed_ms: f64,
    #[serde(default)]
    dropped_records: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gap: Option<Gap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<Kind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    utc_anchor_ms: Option<u64>,
}
#[derive(Clone, Copy)]
struct Limits {
    record: usize,
    lines: usize,
    maps: usize,
    file: usize,
    flush: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            record: RECORD_BYTES,
            lines: BUFFER_LINES,
            maps: MAP_ENTRIES,
            file: FILE_BYTES,
            flush: FLUSH_WAIT,
        }
    }
}

/// Owns one bounded queue and one writer thread. No task content is persisted.
pub struct Recorder {
    path: PathBuf,
    sender: Option<mpsc::SyncSender<Vec<u8>>>,
    done: mpsc::Receiver<()>,
    write_failed: Arc<AtomicBool>,
    started: Instant,
    limits: Limits,
    seq: u64,
    segment: u64,
    next_run: u64,
    run: Option<u64>,
    next_request: u64,
    request: Option<u64>,
    ambiguous_request: bool,
    next_tool: u64,
    tools: HashMap<String, Option<u64>>,
    first: HashSet<Kind>,
    admitted_bytes: usize,
    drops: usize,
    disabled: Option<Gap>,
    closed: bool,
}
impl Recorder {
    pub fn new(directory: &str, options: Value) -> Result<Self, &'static str> {
        let path = Path::new(directory);
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("open_failed");
        }
        fs::create_dir_all(path).map_err(|_| "open_failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "open_failed")?;
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "open_failed")?
            .as_nanos();
        let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let filename = path.join(format!("trace-{stamp}-{sequence}.jsonl"));
        let mut open = OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = open.open(&filename).map_err(|_| "open_failed")?;
        Self::with_writer(filename, file, options, Limits::default())
    }

    fn with_writer<W: Write + Send + 'static>(
        path: PathBuf,
        writer: W,
        options: Value,
        limits: Limits,
    ) -> Result<Self, &'static str> {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(limits.lines);
        let (done_sender, done) = mpsc::sync_channel(1);
        let write_failed = Arc::new(AtomicBool::new(false));
        let worker_failed = Arc::clone(&write_failed);
        std::thread::Builder::new()
            .name("shazam-phase-writer".into())
            .spawn(move || {
                let mut writer = BufWriter::new(writer);
                let result = (|| -> io::Result<()> {
                    while let Ok(line) = receiver.recv() {
                        writer.write_all(&line)?;
                        while let Ok(line) = receiver.try_recv() {
                            writer.write_all(&line)?;
                        }
                        writer.flush()?;
                    }
                    writer.flush()
                })();
                if result.is_err() {
                    worker_failed.store(true, Ordering::Release);
                }
                // No raw I/O error is printed or sent across the binding boundary.
                let _ = done_sender.try_send(());
            })
            .map_err(|_| "writer_unavailable")?;
        let mut this = Self {
            path,
            sender: Some(sender),
            done,
            write_failed,
            started: Instant::now(),
            limits,
            seq: 0,
            segment: 0,
            next_run: 0,
            run: None,
            next_request: 0,
            request: None,
            ambiguous_request: false,
            next_tool: 0,
            tools: HashMap::new(),
            first: HashSet::new(),
            admitted_bytes: 0,
            drops: 0,
            disabled: None,
            closed: false,
        };
        let mut header = this.record(Kind::Header, 0.0);
        header.capabilities = Some(
            options
                .get("capabilities")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(Kind::parse)
                .take(32)
                .collect(),
        );
        header.runtime_version = options
            .get("runtimeVersion")
            .and_then(Value::as_str)
            .and_then(safe_version);
        header.utc_anchor_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());
        this.admit(header);
        Ok(this)
    }

    pub fn begin_session(&mut self, _key: &str) {
        if !self.active() {
            return;
        }
        self.segment = self.segment.saturating_add(1);
        self.run = None;
        self.reset_correlations();
        let record = self.record(Kind::SessionStart, self.elapsed());
        self.admit(record);
    }

    pub fn event(&mut self, kind: &str, input: Value) {
        let Some(kind) = Kind::parse(kind) else {
            return;
        };
        if !self.active() {
            return;
        }
        self.event_at(kind, Input::from_value(input), self.elapsed());
    }

    fn event_at(&mut self, kind: Kind, input: Input, elapsed: f64) {
        if !self.active() {
            return;
        }
        if kind == Kind::RunStart {
            self.next_run = self.next_run.saturating_add(1);
            self.run = Some(self.next_run);
            self.reset_correlations();
        }
        if kind == Kind::RequestStart {
            self.ambiguous_request = self.request.is_some();
            self.next_request = self.next_request.saturating_add(1);
            self.request = Some(self.next_request);
            self.first.clear();
        }
        if kind.first() && !self.first.insert(kind) {
            return;
        }
        let mut record = self.record(kind, elapsed);
        record.outcome = input.outcome;
        record.usage = input.usage;
        if kind == Kind::RecordingGap {
            record.gap = Some(Gap::UnknownCorrelation);
        }
        if kind.first() || matches!(kind, Kind::MessageEnd | Kind::RequestStart) {
            if self.request.is_none() || self.ambiguous_request {
                record.request = None;
                record.gap = Some(Gap::UnknownCorrelation);
            }
        }
        match kind {
            Kind::ToolStart => {
                if let Some(id) = input.tool_id {
                    if self.tools.contains_key(&id) {
                        // A repeated ID remains ambiguous until a lifecycle reset.
                        self.tools.insert(id, None);
                    } else if self.tools.len() < self.limits.maps {
                        self.next_tool = self.next_tool.saturating_add(1);
                        self.tools.insert(id, Some(self.next_tool));
                        record.tool = Some(self.next_tool);
                    }
                }
                if record.tool.is_none() {
                    record.gap = Some(Gap::UnknownCorrelation);
                }
            }
            Kind::ToolEnd => {
                record.tool = input.tool_id.and_then(|id| {
                    let alias = self.tools.get(&id).copied().flatten();
                    if alias.is_some() {
                        self.tools.remove(&id);
                    }
                    alias
                });
                if record.tool.is_none() {
                    record.gap = Some(Gap::UnknownCorrelation);
                }
            }
            _ => {}
        }
        self.admit(record);
        if kind == Kind::MessageEnd {
            self.request = None;
            self.ambiguous_request = false;
            self.first.clear();
        }
        if kind == Kind::Settled {
            self.reset_correlations();
        }
    }

    fn elapsed(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1_000.0
    }
    fn record(&mut self, event: Kind, elapsed_ms: f64) -> Record {
        self.seq = self.seq.saturating_add(1);
        Record {
            schema_version: 1,
            event,
            seq: self.seq,
            segment: self.segment,
            elapsed_ms,
            dropped_records: self.drops,
            run: self.run,
            request: self.request,
            tool: None,
            outcome: None,
            usage: None,
            gap: None,
            capabilities: None,
            runtime_version: None,
            utc_anchor_ms: None,
        }
    }
    fn reset_correlations(&mut self) {
        self.tools.clear();
        self.first.clear();
        self.request = None;
        self.ambiguous_request = false;
    }
    fn active(&mut self) -> bool {
        if self.closed || self.disabled.is_some() {
            return false;
        }
        if self.write_failed.load(Ordering::Acquire) {
            self.disable(Gap::WriteFailed);
            return false;
        }
        true
    }
    fn disable(&mut self, reason: Gap) {
        self.disabled.get_or_insert(reason);
        self.reset_correlations();
        self.sender.take(); // disconnect, then the worker drains already admitted records
    }
    fn admit(&mut self, record: Record) {
        if self.disabled.is_some() || self.closed {
            return;
        }
        let Ok(mut line) = serde_json::to_vec(&record) else {
            self.disable(Gap::RecordLimit);
            return;
        };
        line.push(b'\n');
        if line.len() > self.limits.record {
            self.disable(Gap::RecordLimit);
            return;
        }
        if self.admitted_bytes.saturating_add(line.len()) > self.limits.file {
            self.disable(Gap::FileLimit);
            return;
        }
        let bytes = line.len();
        let Some(sender) = self.sender.as_ref() else {
            return;
        };
        match sender.try_send(line) {
            Ok(()) => self.admitted_bytes += bytes,
            Err(mpsc::TrySendError::Full(_)) => self.drops = self.drops.saturating_add(1),
            Err(mpsc::TrySendError::Disconnected(_)) => self.disable(Gap::WriteFailed),
        }
    }

    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        if self.active() {
            let end = self.record(Kind::ProcessEnd, self.elapsed());
            self.admit(end);
        }
        self.closed = true;
        self.reset_correlations();
        self.sender.take();
        if self.done.recv_timeout(self.limits.flush).is_err() {
            self.disabled.get_or_insert(Gap::FlushTimeout);
        }
        if self.write_failed.load(Ordering::Acquire) {
            self.disabled = Some(Gap::WriteFailed);
        }
    }

    pub fn summary(&mut self) -> String {
        if self.write_failed.load(Ordering::Acquire) && !self.closed {
            self.disable(Gap::WriteFailed);
        }
        let mut open = OpenOptions::new();
        open.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.custom_flags(libc::O_NOFOLLOW);
        }
        let data = match open.open(&self.path) {
            Ok(file) => summarize(file, self.limits),
            Err(_) => "Recording unavailable: read_failed".into(),
        };
        let state = self.disabled.map(Gap::label).unwrap_or(if self.closed {
            "closed"
        } else {
            "live snapshot; buffered events may be absent"
        });
        format!("{data}\nRecorder: {state}; dropped records: {}\nFile: {}\nHistorical files require manual cleanup.", self.drops, self.path.display())
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        self.close();
    }
}

fn safe_version(text: &str) -> Option<String> {
    if text.len() > 40 {
        return None;
    }
    let mut values = text.split('.');
    let a = values.next()?.parse::<u16>().ok()?;
    let b = values.next()?.parse::<u16>().ok()?;
    let c = values.next()?.parse::<u16>().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(format!("{a}.{b}.{c}"))
}

#[derive(Default)]
struct Summary {
    request: Option<(u64, f64)>,
    first: Option<f64>,
    response_end: Option<f64>,
    cancel: Option<f64>,
    settled: Option<f64>,
    tools: HashMap<u64, f64>,
    intervals: Vec<(f64, f64)>,
    gaps: usize,
    incomplete: bool,
}
fn summarize(file: File, limits: Limits) -> String {
    let mut state = Summary::default();
    let mut reader = BufReader::new(file.take((limits.file + 1) as u64));
    let mut read = 0;
    loop {
        let mut line = Vec::new();
        let Ok(count) = reader.read_until(b'\n', &mut line) else {
            state.incomplete = true;
            break;
        };
        if count == 0 {
            break;
        }
        read += count;
        if read > limits.file || line.len() > limits.record {
            state.incomplete = true;
            break;
        }
        if line.last() != Some(&b'\n') {
            state.incomplete = true;
            break;
        }
        line.pop();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Record>(&line) else {
            state.incomplete = true;
            continue;
        };
        if record.schema_version != 1 || !record.elapsed_ms.is_finite() || record.elapsed_ms < 0.0 {
            state.incomplete = true;
            continue;
        }
        if matches!(record.event, Kind::RunStart | Kind::SessionStart) {
            state = Summary::default();
        }
        state.incomplete |= record.dropped_records > 0;
        if record.gap.is_some() {
            state.gaps = state.gaps.saturating_add(1);
        }
        match record.event {
            Kind::RequestStart => {
                state.request = record.request.map(|id| (id, record.elapsed_ms));
                state.first = None;
                state.response_end = None;
            }
            Kind::FirstProviderEvent => {
                if state
                    .request
                    .is_some_and(|(id, _)| Some(id) == record.request)
                {
                    state.first = Some(record.elapsed_ms);
                }
            }
            Kind::MessageEnd => {
                if state
                    .request
                    .is_some_and(|(id, _)| Some(id) == record.request)
                {
                    state.response_end = Some(record.elapsed_ms);
                }
            }
            Kind::CancelRequested => state.cancel = Some(record.elapsed_ms),
            Kind::Settled => state.settled = Some(record.elapsed_ms),
            Kind::ToolStart => {
                if let Some(id) = record.tool {
                    if state.tools.len() < limits.maps {
                        state.tools.insert(id, record.elapsed_ms);
                    } else {
                        state.incomplete = true;
                    }
                }
            }
            Kind::ToolEnd => {
                if let Some(start) = record.tool.and_then(|id| state.tools.remove(&id)) {
                    if record.elapsed_ms >= start {
                        state.intervals.push((start, record.elapsed_ms));
                    } else {
                        state.incomplete = true;
                    }
                }
            }
            _ => {}
        }
    }
    let duration = |end: Option<f64>, start: Option<f64>| match end.zip(start) {
        Some((end, start)) if end >= start => format!("{:.0} ms", end - start),
        _ => "unknown".into(),
    };
    let sum: f64 = state.intervals.iter().map(|(a, b)| b - a).sum();
    state.intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut union = 0.0;
    let mut merged: Option<(f64, f64)> = None;
    for (start, end) in state.intervals {
        match merged {
            Some((a, b)) if start <= b => merged = Some((a, b.max(end))),
            Some((a, b)) => {
                union += b - a;
                merged = Some((start, end));
            }
            None => merged = Some((start, end)),
        }
    }
    if let Some((a, b)) = merged {
        union += b - a;
    }
    let incomplete = state.incomplete || !state.tools.is_empty() || state.gaps > 0;
    format!("Request to first event: {}\nFirst event to response end: {}\nCancellation to settlement: {}\nTool elapsed coverage: {union:.0} ms; summed duration: {sum:.0} ms\nCoverage: {}; correlation gaps: {}",
        duration(state.first, state.request.map(|(_,start)| start)), duration(state.response_end, state.first),
        duration(state.settled, state.cancel), if incomplete { "incomplete" } else { "observed boundaries only" }, state.gaps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Recorder) {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Recorder::new(dir.path().to_str().unwrap(), json!({"runtimeVersion":"1.0.4","capabilities":["request_start","first_provider_event","settled"]})).unwrap();
        (dir, recorder)
    }
    fn records(recorder: &Recorder) -> Vec<Value> {
        fs::read_to_string(&recorder.path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn at(recorder: &mut Recorder, kind: Kind, at: f64, input: Value) {
        recorder.event_at(kind, Input::from_value(input), at);
    }

    #[test]
    fn actual_file_has_private_safe_milestones_and_deduplicates_first_arrival() {
        let (_dir, mut recorder) = fixture();
        recorder.begin_session("SECRET_SESSION");
        at(&mut recorder, Kind::RunStart, 0.0, json!({}));
        at(&mut recorder, Kind::RequestStart, 10.0, json!({}));
        at(
            &mut recorder,
            Kind::FirstProviderEvent,
            20.0,
            json!({"text":"SECRET_TEXT"}),
        );
        at(&mut recorder, Kind::FirstProviderEvent, 25.0, json!({}));
        at(
            &mut recorder,
            Kind::FirstReasoning,
            25.0,
            json!({"reasoning":"SECRET_REASONING"}),
        );
        at(
            &mut recorder,
            Kind::MessageEnd,
            40.0,
            json!({"outcome":"ok","usage":{"input":10,"output":2}}),
        );
        at(
            &mut recorder,
            Kind::ToolStart,
            40.0,
            json!({"toolCallId":"SECRET_TOOL","args":{"path":"SECRET_PATH"}}),
        );
        at(
            &mut recorder,
            Kind::ToolEnd,
            50.0,
            json!({"toolCallId":"SECRET_TOOL","outcome":"ok"}),
        );
        at(&mut recorder, Kind::Settled, 55.0, json!({}));
        recorder.close();
        let data = records(&recorder);
        assert_eq!(
            data.iter()
                .filter(|row| row["event"] == "first_provider_event")
                .count(),
            1
        );
        assert!(!serde_json::to_string(&data).unwrap().contains("SECRET"));
        assert_eq!(data.last().unwrap()["event"], "process_end");
        let summary = recorder.summary();
        assert!(
            summary.contains("Request to first event: 10 ms"),
            "{summary}"
        );
        assert!(summary.contains("First event to response end: 20 ms"));
        assert!(summary.contains("Cancellation to settlement: unknown"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&recorder.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn tool_summary_distinguishes_overlap_union_from_sum() {
        let (_dir, mut recorder) = fixture();
        recorder.begin_session("s");
        at(&mut recorder, Kind::RunStart, 0.0, json!({}));
        at(
            &mut recorder,
            Kind::ToolStart,
            0.0,
            json!({"toolCallId":"a"}),
        );
        at(
            &mut recorder,
            Kind::ToolStart,
            20.0,
            json!({"toolCallId":"b"}),
        );
        at(
            &mut recorder,
            Kind::ToolEnd,
            30.0,
            json!({"toolCallId":"a"}),
        );
        at(
            &mut recorder,
            Kind::ToolEnd,
            50.0,
            json!({"toolCallId":"b"}),
        );
        recorder.close();
        assert!(recorder
            .summary()
            .contains("Tool elapsed coverage: 50 ms; summed duration: 60 ms"));
    }

    #[test]
    fn caps_bound_aliases_and_recording_and_disabled_events_retain_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        let limits = Limits {
            maps: 2,
            file: 1_000,
            ..Limits::default()
        };
        let mut recorder = Recorder::with_writer(
            path.clone(),
            File::create(&path).unwrap(),
            json!({}),
            limits,
        )
        .unwrap();
        for i in 0..1000 {
            recorder.event("tool_start", json!({"toolCallId":format!("secret-{i}")}));
        }
        assert!(recorder.tools.len() <= 2);
        assert!(matches!(recorder.disabled, Some(Gap::FileLimit)));
        assert_eq!(recorder.tools.len(), 0);
        let seq = recorder.seq;
        for _ in 0..1000 {
            recorder.event("request_start", json!({}));
            recorder.begin_session("ignored");
        }
        assert_eq!(recorder.seq, seq);
        recorder.close();
        assert!(fs::metadata(path).unwrap().len() <= 1_000);
    }

    #[test]
    fn malformed_usage_and_missing_correlation_are_not_fabricated() {
        let (_dir, mut recorder) = fixture();
        recorder.event("message_end", json!({"usage":{"input":-1,"output":1.5,"cacheRead":9007199254740992u64,"cacheWrite":12},"outcome":"aborted"}));
        recorder.close();
        let rows = records(&recorder);
        let end = rows
            .iter()
            .find(|row| row["event"] == "message_end")
            .unwrap();
        assert_eq!(end["usage"], json!({"cacheWrite":12}));
        assert_eq!(end["gap"], "unknown_correlation");
        assert!(recorder
            .summary()
            .contains("Request to first event: unknown"));
    }

    #[test]
    fn duplicate_tool_ids_stay_ambiguous_until_lifecycle_reset() {
        let (_dir, mut recorder) = fixture();
        for _ in 0..3 {
            recorder.event("tool_start", json!({"toolCallId":"same"}));
        }
        recorder.event("tool_end", json!({"toolCallId":"same"}));
        recorder.close();
        let rows = records(&recorder);
        let end = rows.iter().find(|row| row["event"] == "tool_end").unwrap();
        assert!(
            end.get("tool").is_none(),
            "duplicate start must not join an arbitrary end"
        );
        assert_eq!(end["gap"], "unknown_correlation");
    }

    #[test]
    fn changed_session_discards_pending_tool_correlation() {
        let (_dir, mut recorder) = fixture();
        recorder.begin_session("one");
        recorder.event("tool_start", json!({"toolCallId":"id"}));
        recorder.begin_session("two");
        recorder.event("tool_end", json!({"toolCallId":"id"}));
        recorder.close();
        let rows = records(&recorder);
        assert_eq!(
            rows.iter().find(|row| row["event"] == "tool_end").unwrap()["gap"],
            "unknown_correlation"
        );
    }

    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("SECRET_ERROR"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("SECRET_ERROR"))
        }
    }
    #[test]
    fn io_errors_disable_without_leaking_raw_error_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::with_writer(
            dir.path().join("fake"),
            FailingWriter,
            json!({}),
            Limits::default(),
        )
        .unwrap();
        recorder.event("run_start", json!({}));
        recorder.close();
        let summary = recorder.summary();
        assert!(summary.contains("write_failed"));
        assert!(!summary.contains("SECRET"));
    }

    struct StalledWriter {
        started: Option<mpsc::SyncSender<()>>,
        resume: mpsc::Receiver<()>,
    }
    impl Write for StalledWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
                let _ = self.resume.recv();
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn overload_is_lossy_and_close_has_a_bounded_wait() {
        let dir = tempfile::tempdir().unwrap();
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::sync_channel(1);
        let writer = StalledWriter {
            started: Some(started_tx),
            resume: resume_rx,
        };
        let limits = Limits {
            lines: 2,
            flush: Duration::from_millis(20),
            ..Limits::default()
        };
        let mut recorder =
            Recorder::with_writer(dir.path().join("fake"), writer, json!({}), limits).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..20 {
            recorder.event("turn_start", json!({}));
        }
        assert!(recorder.drops > 0);
        let before = Instant::now();
        recorder.close();
        assert!(before.elapsed() < Duration::from_millis(200));
        assert!(recorder.summary().contains("flush_timeout"));
        resume_tx.send(()).unwrap();
        recorder.done.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn short_record_limit_disables_header_and_later_recording() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        let mut recorder = Recorder::with_writer(
            path.clone(),
            File::create(path).unwrap(),
            json!({}),
            Limits {
                record: 8,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(matches!(recorder.disabled, Some(Gap::RecordLimit)));
        recorder.event("run_start", json!({}));
        recorder.close();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let linked = dir.path().join("link");
        std::os::unix::fs::symlink(std::env::temp_dir(), &linked).unwrap();
        assert!(matches!(
            Recorder::new(linked.to_str().unwrap(), json!({})),
            Err("open_failed")
        ));
    }

    #[test]
    fn request_overlap_is_unknown_not_assigned_to_latest_request() {
        let (_dir, mut recorder) = fixture();
        recorder.event("request_start", json!({}));
        recorder.event("request_start", json!({}));
        recorder.event("first_provider_event", json!({}));
        recorder.event("message_end", json!({}));
        recorder.close();
        let rows = records(&recorder);
        for row in rows
            .iter()
            .filter(|row| row["event"] == "first_provider_event" || row["event"] == "message_end")
        {
            assert_eq!(row["gap"], "unknown_correlation");
            assert!(row.get("request").is_none());
        }
    }

    #[test]
    fn truncated_final_line_is_not_treated_as_a_complete_record() {
        let (_dir, mut recorder) = fixture();
        recorder.event("run_start", json!({}));
        recorder.close();
        let mut data = fs::read(&recorder.path).unwrap();
        assert_eq!(data.pop(), Some(b'\n'));
        fs::write(&recorder.path, data).unwrap();
        assert!(recorder.summary().contains("Coverage: incomplete"));
    }

    #[test]
    fn persisted_loss_counter_and_gap_events_keep_offline_coverage_honest() {
        let (_dir, mut recorder) = fixture();
        // The overload test exercises actual queue loss. Here, isolate its
        // persisted projection without introducing nondeterministic disk timing.
        recorder.drops = 3;
        recorder.event("run_start", json!({}));
        recorder.event("recording_gap", json!({"reason":"SECRET_REASON"}));
        recorder.close();
        let rows = records(&recorder);
        let run = rows.iter().find(|row| row["event"] == "run_start").unwrap();
        assert_eq!(run["dropped_records"], 3);
        assert!(recorder.summary().contains("Coverage: incomplete"));
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET"));
    }
}
