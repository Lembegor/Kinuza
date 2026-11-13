use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};

use anyhow::{bail, Context};
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{watch, Semaphore},
};

use crate::{ffmpeg, mpv, AppState};

const SAMPLE_RATE: usize = 11025;
const FRAME: usize = 2048;
const HOP: usize = 512;
const BANDS: usize = 33;
const LOW_HZ: f32 = 300.0;
const HIGH_HZ: f32 = 2000.0;
const QUIET_RMS: f32 = 80.0;
const FOLDER_NAME: &str = "fingerprints";
const KEPT_FILES: usize = 1200;
const MAGIC: &[u8; 4] = b"KFP1";
const DECODE_TIMEOUT: Duration = Duration::from_secs(25 * 60);
const LONGEST_REGION_SECONDS: f64 = 900.0;
const SHORTEST_REGION_SECONDS: f64 = 30.0;
const DECODES_AT_ONCE: usize = 2;

const BUSY_HASH_POSITIONS: usize = 24;
const LEAST_VOTES: u32 = 10;
const SHIFTS_TRIED: usize = 12;
const SHIFT_SPACING: i64 = 6;
const SMOOTHING_FRAMES: usize = 21;
const MATCHED_DISTANCE: f32 = 9.5;
const EDGE_DISTANCE: u32 = 12;
const QUIET_DISTANCE: u32 = 20;
const MERGE_GAP_SECONDS: f64 = 2.5;

const INTRO_SHORTEST_SECONDS: f64 = 15.0;
const INTRO_LONGEST_SECONDS: f64 = 180.0;
const CREDITS_SHORTEST_SECONDS: f64 = 15.0;
const SCENE_SHORTEST_SECONDS: f64 = 15.0;
const SCENE_SOUND_SECONDS: f64 = 8.0;
const SCENE_SOUND_SHARE: f64 = 0.5;

const ERROR_DECODER_MISSING: &str = "decoder_missing";
const ERROR_PRINT_FAILED: &str = "print_failed";
const ERROR_PRINT_CANCELLED: &str = "print_cancelled";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct PrintState {
    cancel: watch::Sender<u64>,
    slots: Semaphore,
}

impl Default for PrintState {
    fn default() -> Self {
        Self { cancel: watch::Sender::new(0), slots: Semaphore::new(DECODES_AT_ONCE) }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Head,
    Tail,
}

impl Part {
    fn name(self) -> &'static str {
        match self {
            Part::Head => "head",
            Part::Tail => "tail",
        }
    }

    fn code(self) -> u8 {
        match self {
            Part::Head => 0,
            Part::Tail => 1,
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrintTarget {
    info_hash: String,
    file_index: usize,
}

impl PrintTarget {
    fn key(&self) -> Option<String> {
        let hash = self.info_hash.to_ascii_lowercase();
        (!hash.is_empty() && hash.len() <= 64 && hash.chars().all(|letter| letter.is_ascii_hexdigit()))
            .then(|| format!("{hash}-{}", self.file_index))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Print {
    offset: f64,
    hashes: Vec<u32>,
    quiet: Vec<bool>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub start: f64,
    pub end: f64,
    pub scene_after: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Segments {
    intro: Option<Span>,
    credits: Option<Credits>,
}

fn hop_seconds() -> f64 {
    HOP as f64 / SAMPLE_RATE as f64
}

fn seconds_to_frames(seconds: f64) -> usize {
    (seconds / hop_seconds()).round().max(0.0) as usize
}

fn band_edges() -> [usize; BANDS + 1] {
    let mut edges = [0; BANDS + 1];
    for (index, edge) in edges.iter_mut().enumerate() {
        let hertz = LOW_HZ * (HIGH_HZ / LOW_HZ).powf(index as f32 / BANDS as f32);
        *edge = (hertz * FRAME as f32 / SAMPLE_RATE as f32).round() as usize;
    }
    edges
}

pub fn fingerprint(samples: &[i16], offset: f64) -> Print {
    let mut print = Print { offset: offset + hop_seconds(), hashes: Vec::new(), quiet: Vec::new() };
    if samples.len() < FRAME + HOP {
        return print;
    }
    let frames = (samples.len() - FRAME) / HOP + 1;
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FRAME);
    let window: Vec<f32> = (0..FRAME)
        .map(|index| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (FRAME - 1) as f32).cos())
        .collect();
    let edges = band_edges();
    let mut buffer = vec![Complex32::new(0.0, 0.0); FRAME];
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut previous = [0f32; BANDS];
    print.hashes.reserve(frames);
    print.quiet.reserve(frames);
    for frame in 0..frames {
        let chunk = &samples[frame * HOP..frame * HOP + FRAME];
        let mut power = 0f64;
        for ((slot, &sample), &weight) in buffer.iter_mut().zip(chunk).zip(&window) {
            power += f64::from(sample) * f64::from(sample);
            *slot = Complex32::new(f32::from(sample) * weight, 0.0);
        }
        let loudness = (power / FRAME as f64).sqrt() as f32;
        fft.process_with_scratch(&mut buffer, &mut scratch);
        let mut energies = [0f32; BANDS];
        for (band, energy) in energies.iter_mut().enumerate() {
            *energy = buffer[edges[band]..edges[band + 1].max(edges[band] + 1)].iter().map(|bin| bin.norm_sqr()).sum();
        }
        if frame > 0 {
            let mut hash = 0u32;
            for bit in 0..BANDS - 1 {
                let now = energies[bit] - energies[bit + 1];
                let before = previous[bit] - previous[bit + 1];
                if now - before > 0.0 {
                    hash |= 1 << bit;
                }
            }
            print.hashes.push(hash);
            print.quiet.push(loudness < QUIET_RMS);
        }
        previous = energies;
    }
    print
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Run {
    pub first: usize,
    pub last: usize,
    pub other_first: usize,
    pub distance: f32,
}

impl Run {
    fn frames(&self) -> usize {
        self.last + 1 - self.first
    }
}

fn candidate_shifts(first: &Print, second: &Print) -> Vec<i64> {
    let mut index: HashMap<u32, Vec<u32>> = HashMap::new();
    for (position, (&hash, &quiet)) in second.hashes.iter().zip(&second.quiet).enumerate() {
        if !quiet {
            index.entry(hash).or_default().push(position as u32);
        }
    }
    index.retain(|_, positions| positions.len() <= BUSY_HASH_POSITIONS);
    let base = first.hashes.len() as i64;
    let mut votes = vec![0u32; first.hashes.len() + second.hashes.len() + 1];
    for (position, (&hash, &quiet)) in first.hashes.iter().zip(&first.quiet).enumerate() {
        if quiet {
            continue;
        }
        let mut cast = |probe: u32| {
            if let Some(found) = index.get(&probe) {
                for &other in found {
                    let shift = other as i64 - position as i64 + base;
                    votes[shift as usize] += 1;
                }
            }
        };
        cast(hash);
        for bit in 0..BANDS - 1 {
            cast(hash ^ (1 << bit));
        }
    }
    let smoothed: Vec<u32> = (0..votes.len())
        .map(|slot| {
            let low = slot.saturating_sub(1);
            let high = (slot + 1).min(votes.len() - 1);
            votes[low..=high].iter().sum()
        })
        .collect();
    let mut order: Vec<usize> = (0..smoothed.len()).filter(|&slot| smoothed[slot] >= LEAST_VOTES).collect();
    order.sort_by(|a, b| smoothed[*b].cmp(&smoothed[*a]));
    let mut picked: Vec<i64> = Vec::new();
    for slot in order {
        let shift = slot as i64 - base;
        if picked.iter().all(|other| (other - shift).abs() > SHIFT_SPACING) {
            picked.push(shift);
            if picked.len() == SHIFTS_TRIED {
                break;
            }
        }
    }
    picked
}

fn runs_at_shift(first: &Print, second: &Print, shift: i64) -> Vec<Run> {
    let start = (-shift).max(0) as usize;
    let end = (second.hashes.len() as i64 - shift).min(first.hashes.len() as i64).max(0) as usize;
    if end <= start + SMOOTHING_FRAMES {
        return Vec::new();
    }
    let distances: Vec<u32> = (start..end)
        .map(|position| {
            let other = (position as i64 + shift) as usize;
            if first.quiet[position] || second.quiet[other] {
                QUIET_DISTANCE
            } else {
                (first.hashes[position] ^ second.hashes[other]).count_ones()
            }
        })
        .collect();
    let mut sums = vec![0u64; distances.len() + 1];
    for (index, &distance) in distances.iter().enumerate() {
        sums[index + 1] = sums[index] + u64::from(distance);
    }
    let half = SMOOTHING_FRAMES / 2;
    let matched: Vec<bool> = (0..distances.len())
        .map(|index| {
            let low = index.saturating_sub(half);
            let high = (index + half + 1).min(distances.len());
            (sums[high] - sums[low]) as f32 / (high - low) as f32 <= MATCHED_DISTANCE
        })
        .collect();
    let gap = seconds_to_frames(MERGE_GAP_SECONDS);
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut index = 0;
    while index < matched.len() {
        if !matched[index] {
            index += 1;
            continue;
        }
        let begin = index;
        while index < matched.len() && matched[index] {
            index += 1;
        }
        let finish = index - 1;
        match spans.last_mut() {
            Some(last) if begin - last.1 <= gap => last.1 = finish,
            _ => spans.push((begin, finish)),
        }
    }
    spans
        .into_iter()
        .filter_map(|(mut begin, mut finish)| {
            while begin < finish && distances[begin] > EDGE_DISTANCE {
                begin += 1;
            }
            while finish > begin && distances[finish] > EDGE_DISTANCE {
                finish -= 1;
            }
            let distance = (sums[finish + 1] - sums[begin]) as f32 / (finish + 1 - begin) as f32;
            Some(Run {
                first: start + begin,
                last: start + finish,
                other_first: (start as i64 + begin as i64 + shift) as usize,
                distance,
            })
        })
        .collect()
}

pub fn shared_runs(first: &Print, second: &Print, shortest_seconds: f64) -> Vec<Run> {
    if first.hashes.is_empty() || second.hashes.is_empty() {
        return Vec::new();
    }
    let shortest = seconds_to_frames(shortest_seconds);
    let mut runs: Vec<Run> = Vec::new();
    for shift in candidate_shifts(first, second) {
        let best_here = (shift - 1..=shift + 1)
            .flat_map(|nearby| runs_at_shift(first, second, nearby))
            .filter(|run| run.frames() >= shortest)
            .collect::<Vec<_>>();
        for run in best_here {
            let overlapping = runs.iter().position(|kept| run.first <= kept.last && kept.first <= run.last);
            match overlapping {
                Some(slot) if better(&run, &runs[slot]) => runs[slot] = run,
                Some(_) => {}
                None => runs.push(run),
            }
        }
    }
    runs.sort_by_key(|run| run.first);
    runs
}

fn better(candidate: &Run, kept: &Run) -> bool {
    let (a, b) = (candidate.frames(), kept.frames());
    a > b || (a == b && candidate.distance < kept.distance)
}

fn time_of(print: &Print, frame: usize) -> f64 {
    print.offset + frame as f64 * hop_seconds()
}

fn pick_agreed(candidates: Vec<(Run, usize)>) -> Option<Run> {
    let support = |run: &Run| candidates.iter().filter(|(other, _)| other.first <= run.last && run.first <= other.last).map(|(_, source)| *source).collect::<std::collections::HashSet<_>>().len();
    candidates
        .iter()
        .map(|(run, _)| (support(run), *run))
        .max_by(|(support_a, a), (support_b, b)| support_a.cmp(support_b).then(a.frames().cmp(&b.frames())).then(b.distance.total_cmp(&a.distance)))
        .map(|(_, run)| run)
}

pub fn find_intro(target: &Print, neighbours: &[Print]) -> Option<Span> {
    let longest = seconds_to_frames(INTRO_LONGEST_SECONDS);
    let candidates = neighbours
        .iter()
        .enumerate()
        .flat_map(|(source, other)| shared_runs(target, other, INTRO_SHORTEST_SECONDS).into_iter().map(move |run| (run, source)))
        .filter(|(run, _)| run.frames() <= longest)
        .collect::<Vec<_>>();
    let run = pick_agreed(candidates)?;
    Some(Span { start: time_of(target, run.first).max(0.0), end: time_of(target, run.last + 1) })
}

pub fn find_credits(target: &Print, neighbours: &[Print], duration: f64) -> Option<Credits> {
    let candidates = neighbours
        .iter()
        .enumerate()
        .flat_map(|(source, other)| shared_runs(target, other, CREDITS_SHORTEST_SECONDS).into_iter().map(move |run| (run, source)))
        .collect::<Vec<_>>();
    let run = pick_agreed(candidates)?;
    let start = duration + time_of(target, run.first);
    let end = (duration + time_of(target, run.last + 1)).min(duration);
    let rest = &target.quiet[(run.last + 1).min(target.quiet.len())..];
    let sound_seconds = rest.iter().filter(|quiet| !**quiet).count() as f64 * hop_seconds();
    let rest_seconds = duration - end;
    let scene_after = rest_seconds >= SCENE_SHORTEST_SECONDS
        && sound_seconds >= SCENE_SOUND_SECONDS
        && sound_seconds >= SCENE_SOUND_SHARE * rest.len() as f64 * hop_seconds();
    (start > duration / 2.0).then_some(Credits { start, end, scene_after })
}

fn encode(print: &Print, part: Part) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(17 + print.hashes.len() * 4 + print.quiet.len() / 8 + 1);
    bytes.extend_from_slice(MAGIC);
    bytes.push(part.code());
    bytes.extend_from_slice(&print.offset.to_le_bytes());
    bytes.extend_from_slice(&(print.hashes.len() as u32).to_le_bytes());
    for hash in &print.hashes {
        bytes.extend_from_slice(&hash.to_le_bytes());
    }
    for chunk in print.quiet.chunks(8) {
        bytes.push(chunk.iter().enumerate().fold(0u8, |byte, (bit, &quiet)| byte | (u8::from(quiet) << bit)));
    }
    bytes
}

fn decode_print(bytes: &[u8], part: Part) -> Option<Print> {
    let header = 4 + 1 + 8 + 4;
    if bytes.len() < header || &bytes[..4] != MAGIC || bytes[4] != part.code() {
        return None;
    }
    let offset = f64::from_le_bytes(bytes[5..13].try_into().ok()?);
    let count = u32::from_le_bytes(bytes[13..17].try_into().ok()?) as usize;
    let hashes_end = header + count * 4;
    if bytes.len() != hashes_end + count.div_ceil(8) {
        return None;
    }
    let hashes = bytes[header..hashes_end].chunks_exact(4).map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap())).collect();
    let quiet = (0..count).map(|index| bytes[hashes_end + index / 8] >> (index % 8) & 1 == 1).collect();
    Some(Print { offset, hashes, quiet })
}

fn print_path(data_dir: &Path, key: &str, part: Part) -> PathBuf {
    data_dir.join(FOLDER_NAME).join(format!("{key}-{}.kfp", part.name()))
}

fn load(data_dir: &Path, key: &str, part: Part) -> Option<Print> {
    decode_print(&std::fs::read(print_path(data_dir, key, part)).ok()?, part)
}

fn save(data_dir: &Path, key: &str, part: Part, print: &Print) -> std::io::Result<()> {
    crate::store::write_atomic(&print_path(data_dir, key, part), &encode(print, part))?;
    prune(&data_dir.join(FOLDER_NAME));
    Ok(())
}

fn prune(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= KEPT_FILES {
        return;
    }
    files.sort();
    for (_, path) in files.iter().take(files.len() - KEPT_FILES) {
        let _ = std::fs::remove_file(path);
    }
}

fn background(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command.stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    for variable in crate::host::leaked_variables() {
        command.env_remove(variable);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn mpv_on_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let name = "mpv.exe";
    #[cfg(not(windows))]
    let name = "mpv";
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).map(|folder| folder.join(name)).find(|candidate| candidate.is_file()))
}

enum Decoder {
    Ffmpeg(PathBuf),
    Mpv(PathBuf),
}

fn decoder(app: &AppHandle, data_dir: &Path) -> Option<Decoder> {
    ffmpeg::executable(data_dir)
        .map(Decoder::Ffmpeg)
        .or_else(|| mpv::executable(app, data_dir).or_else(mpv_on_path).map(Decoder::Mpv))
}

fn samples_of(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect()
}

async fn decode_audio(decoder: &Decoder, url: &str, part: Part, seconds: f64, scratch: &Path) -> anyhow::Result<Vec<i16>> {
    let length = format!("{seconds:.3}");
    let limit = (seconds * SAMPLE_RATE as f64 * 2.0) as usize + SAMPLE_RATE * 4;
    match decoder {
        Decoder::Ffmpeg(executable) => {
            let mut command = background(executable);
            command.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
            match part {
                Part::Head => command.args(["-i", url, "-t", &length]),
                Part::Tail => command.args(["-sseof", &format!("-{length}"), "-i", url]),
            };
            let sample_rate = SAMPLE_RATE.to_string();
            command
                .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", &sample_rate, "-f", "s16le", "pipe:1"])
                .stdout(Stdio::piped());
            let mut child = command.spawn().context("could not start ffmpeg")?;
            let mut output = Vec::with_capacity(limit);
            let mut stdout = child.stdout.take().context("ffmpeg has no output")?;
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let read = stdout.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                output.extend_from_slice(&chunk[..read]);
                if output.len() >= limit {
                    break;
                }
            }
            drop(stdout);
            let _ = child.kill().await;
            Ok(samples_of(&output))
        }
        Decoder::Mpv(executable) => {
            let _ = std::fs::remove_file(scratch);
            let mut command = background(executable);
            command.stdout(Stdio::null()).args([
                "--no-config",
                "--really-quiet",
                "--terminal=no",
                "--force-window=no",
                "--idle=no",
                "--vid=no",
                "--sid=no",
                "--aid=1",
                "--ao=pcm",
                "--ao-pcm-waveheader=no",
                "--audio-channels=mono",
                "--audio-format=s16",
            ]);
            command.arg(format!("--audio-samplerate={SAMPLE_RATE}"));
            command.arg(format!("--ao-pcm-file={}", scratch.display()));
            match part {
                Part::Head => command.args(["--start=0".to_owned(), format!("--length={length}")]),
                Part::Tail => command.args([format!("--start=-{length}")]),
            };
            command.arg("--").arg(url);
            let status = command.status().await.context("could not start mpv")?;
            let bytes = std::fs::read(scratch).unwrap_or_default();
            let _ = std::fs::remove_file(scratch);
            if bytes.is_empty() {
                bail!("mpv decoded nothing ({status})");
            }
            let mut samples = samples_of(&bytes);
            samples.truncate(limit / 2);
            Ok(samples)
        }
    }
}

#[tauri::command]
pub async fn audio_print(
    app: AppHandle,
    state: State<'_, AppState>,
    prints: State<'_, PrintState>,
    target: PrintTarget,
    part: Part,
    seconds: f64,
) -> Result<bool, String> {
    let key = target.key().ok_or_else(|| ERROR_PRINT_FAILED.to_owned())?;
    let data_dir = state.data_dir.clone();
    if load(&data_dir, &key, part).is_some() {
        return Ok(true);
    }
    let Some(decoder) = decoder(&app, &data_dir) else {
        return Err(ERROR_DECODER_MISSING.to_owned());
    };
    let seconds = seconds.clamp(SHORTEST_REGION_SECONDS, LONGEST_REGION_SECONDS);
    let mut cancelled = prints.cancel.subscribe();
    let _slot = tokio::select! {
        slot = prints.slots.acquire() => slot.map_err(|_| ERROR_PRINT_CANCELLED.to_owned())?,
        _ = cancelled.changed() => return Err(ERROR_PRINT_CANCELLED.to_owned()),
    };
    if load(&data_dir, &key, part).is_some() {
        return Ok(true);
    }
    let url = format!("{}/stream/{}/{}", state.stream_base_url, target.info_hash.to_ascii_lowercase(), target.file_index);
    let scratch = data_dir.join(FOLDER_NAME).join(format!("{key}-{}.pcm.part", part.name()));
    let _ = std::fs::create_dir_all(data_dir.join(FOLDER_NAME));
    let began = std::time::Instant::now();
    let decoded = tokio::select! {
        decoded = tokio::time::timeout(DECODE_TIMEOUT, decode_audio(&decoder, &url, part, seconds, &scratch)) => decoded,
        _ = cancelled.changed() => {
            let _ = std::fs::remove_file(&scratch);
            return Err(ERROR_PRINT_CANCELLED.to_owned());
        }
    };
    let samples = match decoded {
        Ok(Ok(samples)) => samples,
        Ok(Err(error)) => {
            tracing::warn!("fingerprint: {key} {}: {error:#}", part.name());
            return Err(ERROR_PRINT_FAILED.to_owned());
        }
        Err(_) => {
            tracing::warn!("fingerprint: {key} {} timed out", part.name());
            return Err(ERROR_PRINT_FAILED.to_owned());
        }
    };
    let decoded_seconds = samples.len() as f64 / SAMPLE_RATE as f64;
    if decoded_seconds < SHORTEST_REGION_SECONDS.min(seconds * 0.5) {
        tracing::warn!("fingerprint: {key} {} gave only {decoded_seconds:.1}s of sound", part.name());
        return Err(ERROR_PRINT_FAILED.to_owned());
    }
    let offset = match part {
        Part::Head => 0.0,
        Part::Tail => -decoded_seconds,
    };
    let print = tokio::task::spawn_blocking(move || fingerprint(&samples, offset)).await.map_err(|_| ERROR_PRINT_FAILED.to_owned())?;
    save(&data_dir, &key, part, &print).map_err(|error| {
        tracing::warn!("fingerprint: could not save {key}: {error}");
        ERROR_PRINT_FAILED.to_owned()
    })?;
    tracing::info!(
        "fingerprint: {key} {} {decoded_seconds:.0}s in {:.1}s",
        part.name(),
        began.elapsed().as_secs_f64()
    );
    Ok(true)
}

const OFFSET_SHORTEST_SECONDS: f64 = 12.0;

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AudioOffset {
    seconds: f64,
    matched_seconds: f64,
}

pub fn offset_between(first: &Print, second: &Print) -> Option<AudioOffset> {
    let runs = shared_runs(first, second, OFFSET_SHORTEST_SECONDS);
    let best = runs.iter().max_by_key(|run| run.frames())?;
    let frame = HOP as f64 / SAMPLE_RATE as f64;
    let seconds = (best.other_first as f64 - best.first as f64) * frame + (second.offset - first.offset);
    let agreeing: usize = runs
        .iter()
        .filter(|run| ((run.other_first as f64 - run.first as f64) - (best.other_first as f64 - best.first as f64)).abs() <= 3.0)
        .map(Run::frames)
        .sum();
    Some(AudioOffset { seconds, matched_seconds: agreeing as f64 * frame })
}

#[tauri::command]
pub async fn audio_offset(state: State<'_, AppState>, reference: PrintTarget, other: PrintTarget) -> Result<Option<AudioOffset>, String> {
    let (Some(first_key), Some(second_key)) = (reference.key(), other.key()) else {
        return Err(ERROR_PRINT_FAILED.to_owned());
    };
    let data_dir = state.data_dir.clone();
    let found = tokio::task::spawn_blocking(move || {
        let first = load(&data_dir, &first_key, Part::Head)?;
        let second = load(&data_dir, &second_key, Part::Head)?;
        offset_between(&first, &second)
    })
    .await
    .map_err(|_| ERROR_PRINT_FAILED.to_owned())?;
    match found {
        Some(offset) => tracing::info!("fingerprint: the other sound is {:+.2}s apart, {:.0}s matched", offset.seconds, offset.matched_seconds),
        None => tracing::info!("fingerprint: the two sounds do not match"),
    }
    Ok(found)
}

#[tauri::command]
pub fn audio_print_cancel(prints: State<'_, PrintState>) {
    prints.cancel.send_modify(|generation| *generation += 1);
}

#[tauri::command]
pub async fn audio_segments(
    state: State<'_, AppState>,
    target: PrintTarget,
    duration: f64,
    neighbours: Vec<PrintTarget>,
) -> Result<Segments, String> {
    let data_dir = state.data_dir.clone();
    let key = target.key().ok_or_else(|| ERROR_PRINT_FAILED.to_owned())?;
    let others: Vec<String> = neighbours.iter().filter_map(PrintTarget::key).filter(|other| *other != key).collect();
    tokio::task::spawn_blocking(move || {
        let mut segments = Segments::default();
        for part in [Part::Head, Part::Tail] {
            let Some(own) = load(&data_dir, &key, part) else {
                continue;
            };
            let theirs: Vec<Print> = others.iter().filter_map(|other| load(&data_dir, other, part)).collect();
            if theirs.is_empty() {
                continue;
            }
            match part {
                Part::Head => segments.intro = find_intro(&own, &theirs),
                Part::Tail if duration > 0.0 => segments.credits = find_credits(&own, &theirs, duration),
                Part::Tail => {}
            }
        }
        if segments.intro.is_some() || segments.credits.is_some() {
            tracing::info!("fingerprint: {key} found {:?} {:?}", segments.intro, segments.credits);
        }
        segments
    })
    .await
    .map_err(|_| ERROR_PRINT_FAILED.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Noise(u64);

    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % 20001) as f32 / 10000.0 - 1.0
        }
    }

    fn melody(seconds: f64, seed: u64) -> Vec<f32> {
        let mut noise = Noise(seed);
        let notes = [220.0, 247.0, 262.0, 294.0, 330.0, 349.0, 392.0, 440.0, 494.0, 523.0, 587.0, 659.0];
        let count = (seconds * SAMPLE_RATE as f64) as usize;
        let beat = SAMPLE_RATE / 4;
        let mut chosen = Vec::new();
        for _ in 0..count / beat + 1 {
            let pick = |noise: &mut Noise| notes[((noise.next() + 1.0) * 5.99) as usize];
            chosen.push([pick(&mut noise), pick(&mut noise), pick(&mut noise)]);
        }
        (0..count)
            .map(|index| {
                let time = index as f32 / SAMPLE_RATE as f32;
                let chord = chosen[index / beat];
                let envelope = 1.0 - (index % beat) as f32 / beat as f32 * 0.7;
                chord.iter().map(|hertz| (2.0 * std::f32::consts::PI * hertz * time).sin()).sum::<f32>() * 0.25 * envelope
                    + noise.next() * 0.03
            })
            .collect()
    }

    fn speech(seconds: f64, seed: u64) -> Vec<f32> {
        let mut noise = Noise(seed);
        let count = (seconds * SAMPLE_RATE as f64) as usize;
        let mut low = 0f32;
        let mut pitch = 140.0f32;
        (0..count)
            .map(|index| {
                if index % 1500 == 0 {
                    pitch = 100.0 + (noise.next() + 1.0) * 90.0;
                }
                let time = index as f32 / SAMPLE_RATE as f32;
                low = low * 0.9 + noise.next() * 0.1;
                let syllable = ((index / 2200) % 3 != 0) as u8 as f32;
                ((2.0 * std::f32::consts::PI * pitch * time).sin() * 0.3 + low * 2.0) * syllable * 0.6
            })
            .collect()
    }

    fn to_samples(signal: &[f32], gain: f32, seed: u64) -> Vec<i16> {
        let mut noise = Noise(seed);
        signal.iter().map(|value| ((value * gain + noise.next() * 0.01) * 12000.0).clamp(-32767.0, 32767.0) as i16).collect()
    }

    fn episode(parts: &[Vec<f32>]) -> Vec<f32> {
        parts.concat()
    }

    #[test]
    fn finds_how_far_a_dubbed_track_is_shifted() {
        let music = melody(90.0, 7);
        let talking = |index: usize| {
            let second = index / SAMPLE_RATE;
            !(25..70).contains(&second)
        };
        let voiced = |voice: Vec<f32>| -> Vec<f32> {
            music.iter().zip(voice).enumerate().map(|(index, (m, v))| if talking(index) { m + v * 0.5 } else { *m }).collect()
        };
        let original = voiced(speech(90.0, 3));
        let shift = (4.0 * SAMPLE_RATE as f64) as usize;
        let mut dubbed: Vec<f32> = speech(4.0, 11);
        dubbed.extend(voiced(speech(90.0, 5)));
        assert_eq!(dubbed.len(), original.len() + shift);
        let first = fingerprint(&to_samples(&original, 1.0, 1), 0.0);
        let second = fingerprint(&to_samples(&dubbed, 0.8, 2), 0.0);
        let found = offset_between(&first, &second).expect("the shared music should line up");
        assert!((found.seconds - 4.0).abs() < 0.15, "offset {}", found.seconds);
        assert!(found.matched_seconds > 30.0, "matched {}", found.matched_seconds);
    }

    #[test]
    fn finds_the_shared_intro_at_different_places() {
        let theme = melody(50.0, 7);
        let first = to_samples(&episode(&[speech(70.0, 1), theme.clone(), speech(200.0, 2)]), 1.0, 11);
        let second = to_samples(&episode(&[speech(15.0, 3), theme.clone(), speech(260.0, 4)]), 0.8, 12);
        let intro = find_intro(&fingerprint(&first, 0.0), &[fingerprint(&second, 0.0)]).expect("intro found");
        assert!((intro.start - 70.0).abs() < 1.0, "start {}", intro.start);
        assert!((intro.end - 120.0).abs() < 1.0, "end {}", intro.end);
    }

    #[test]
    fn different_episodes_without_a_theme_share_nothing() {
        let first = to_samples(&speech(300.0, 21), 1.0, 1);
        let second = to_samples(&episode(&[speech(100.0, 22), melody(60.0, 9), speech(140.0, 23)]), 1.0, 2);
        assert_eq!(find_intro(&fingerprint(&first, 0.0), &[fingerprint(&second, 0.0)]), None);
    }

    #[test]
    fn silence_is_not_an_intro() {
        let silence = vec![0f32; SAMPLE_RATE * 40];
        let first = to_samples(&episode(&[speech(60.0, 31), silence.clone(), speech(100.0, 32)]), 1.0, 1);
        let second = to_samples(&episode(&[speech(30.0, 33), silence, speech(130.0, 34)]), 1.0, 2);
        assert_eq!(find_intro(&fingerprint(&first, 0.0), &[fingerprint(&second, 0.0)]), None);
    }

    #[test]
    fn credits_running_to_the_end_have_no_scene_after() {
        let song = melody(80.0, 41);
        let first = to_samples(&episode(&[speech(240.0, 42), song.clone()]), 1.0, 1);
        let second = to_samples(&episode(&[speech(200.0, 43), song.clone()]), 0.9, 2);
        let duration = 2400.0;
        let credits = find_credits(&fingerprint(&first, -320.0), &[fingerprint(&second, -280.0)], duration).expect("credits found");
        assert!((credits.start - (duration - 80.0)).abs() < 1.0, "start {}", credits.start);
        assert!(!credits.scene_after);
    }

    #[test]
    fn a_scene_after_the_credits_is_noticed() {
        let song = melody(70.0, 51);
        let first = to_samples(&episode(&[speech(200.0, 52), song.clone(), speech(45.0, 53)]), 1.0, 1);
        let second = to_samples(&episode(&[speech(240.0, 54), song.clone(), vec![0.0; SAMPLE_RATE * 5]]), 1.0, 2);
        let duration = 1500.0;
        let credits = find_credits(&fingerprint(&first, -315.0), &[fingerprint(&second, -315.0)], duration).expect("credits found");
        assert!((credits.end - (duration - 45.0)).abs() < 1.0, "end {}", credits.end);
        assert!(credits.scene_after);
    }

    #[test]
    fn quiet_tail_after_credits_is_not_a_scene() {
        let song = melody(70.0, 61);
        let first = to_samples(&episode(&[speech(200.0, 62), song.clone(), vec![0.0; SAMPLE_RATE * 30]]), 1.0, 1);
        let second = to_samples(&episode(&[speech(220.0, 63), song.clone()]), 1.0, 2);
        let credits = find_credits(&fingerprint(&first, -300.0), &[fingerprint(&second, -290.0)], 1300.0).expect("credits found");
        assert!(!credits.scene_after);
    }

    #[test]
    fn prints_survive_the_disk() {
        let print = fingerprint(&to_samples(&melody(40.0, 71), 1.0, 1), -40.0);
        assert_eq!(decode_print(&encode(&print, Part::Tail), Part::Tail), Some(print.clone()));
        assert_eq!(decode_print(&encode(&print, Part::Tail), Part::Head), None);
    }
}

