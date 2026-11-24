//! Coordinates piece download state by wrapping ChunkTracker with inflight piece tracking.
//!
//! This module provides the [`PieceTracker`] type which encapsulates the relationship between
//! queued pieces (in ChunkTracker) and in-flight pieces (being downloaded by a peer).
//!
//! The key invariant maintained is: a piece is in exactly one state at any time:
//! - HAVE (completed)
//! - QUEUED (available to download)
//! - IN_FLIGHT (currently being downloaded)
//! - NOT_NEEDED (not selected for download)

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use buffers::ByteBuf;
use librqbit_core::lengths::ValidPieceIndex;
use peer_binary_protocol::Piece;

use crate::{
    chunk_tracker::{ChunkMarkingResult, ChunkTracker},
    file_info::FileInfo,
    type_aliases::{FileInfos, FilePriorities, PeerHandle},
};

/// Tracks a piece currently being downloaded.
#[derive(Debug, Clone)]
pub struct InflightPiece {
    pub peer: PeerHandle,
    pub started: Instant,
    pub helpers: Vec<PeerHandle>,
    claims: HashMap<u32, (PeerHandle, Instant)>,
    cursors: Vec<(PeerHandle, u32)>,
    touched: bool,
    progress_at: Instant,
}

impl InflightPiece {
    fn new(peer: PeerHandle) -> Self {
        Self {
            peer,
            started: Instant::now(),
            helpers: Vec::new(),
            claims: HashMap::new(),
            cursors: Vec::new(),
            touched: false,
            progress_at: Instant::now(),
        }
    }

    pub fn has_worker(&self, peer: PeerHandle) -> bool {
        self.peer == peer || self.helpers.contains(&peer)
    }

    fn joinable(&self, peer: PeerHandle) -> bool {
        self.has_worker(peer) || self.helpers.len() < WAITED_HELPERS || self.progress_at.elapsed() >= WAITED_STUCK_AFTER
    }

    fn forget_worker(&mut self, peer: PeerHandle) {
        self.helpers.retain(|p| *p != peer);
        self.claims.retain(|_, (p, _)| *p != peer);
        self.cursors.retain(|(p, _)| *p != peer);
    }
}

/// Result of attempting to acquire a piece.
#[derive(Debug)]
pub enum AcquireResult {
    /// A new piece was reserved from the queue.
    Reserved(ValidPieceIndex),
    /// A piece was stolen from a slower peer.
    Stolen {
        piece: ValidPieceIndex,
        from_peer: PeerHandle,
    },
    Helping(ValidPieceIndex),
    Resumed(ValidPieceIndex),
    /// No pieces are available for this peer.
    NoneAvailable,
}

/// Parameters for acquiring a piece.
pub struct AcquireRequest<'a, I, P, S>
where
    I: Iterator<Item = ValidPieceIndex>,
    P: Fn(ValidPieceIndex) -> bool,
    S: Fn(ValidPieceIndex) -> bool,
{
    /// The peer requesting a piece.
    pub peer: PeerHandle,
    /// The peer's average piece download time (for steal calculations).
    pub peer_avg_time: Option<Duration>,
    /// Priority pieces to check first (e.g., for streaming).
    pub priority_pieces: I,
    /// File download priority ordering.
    pub file_priorities: &'a FilePriorities,
    /// File metadata for iterating pieces.
    pub file_infos: &'a FileInfos,
    /// Returns true if the peer has the given piece.
    pub peer_has_piece: P,
    /// Returns true if the piece can be stolen (e.g., not locked for writing).
    pub can_steal: S,
    pub queue_from: Option<ValidPieceIndex>,
    pub waited: &'a [ValidPieceIndex],
}

/// Coordinates piece download state.
///
/// Wraps a [`ChunkTracker`] with tracking of which pieces are currently being downloaded
/// (in-flight) and by which peer. This ensures that:
///
/// - A piece is only assigned to one peer at a time (unless stolen)
/// - Pieces are properly requeued when a peer dies
/// - State transitions maintain invariants
const URGENT_PIECES: usize = 2;
const URGENT_STEAL_AFTER: Duration = Duration::from_secs(3);
const URGENT_STEAL_UNKNOWN_AFTER: Duration = Duration::from_secs(8);
const URGENT_REFERENCE_PIECE: u32 = 4 * 1024 * 1024;
const WAITED_HELPERS: usize = 8;
const CLAIM_STALE_AFTER: Duration = Duration::from_secs(4);
const WAITED_CLAIM_STALE_AFTER: Duration = Duration::from_millis(1500);
const WAITED_CLAIMS_PER_PEER: usize = 8;
const WAITED_STUCK_AFTER: Duration = Duration::from_secs(3);

pub struct PieceTracker {
    chunks: ChunkTracker,
    inflight: HashMap<ValidPieceIndex, InflightPiece>,
    claim_limits: HashMap<PeerHandle, usize>,
}

impl PieceTracker {
    // === CONSTRUCTION ===

    /// Create a new PieceTracker wrapping the given ChunkTracker.
    pub fn new(chunks: ChunkTracker) -> Self {
        Self {
            chunks,
            inflight: HashMap::new(),
            claim_limits: HashMap::new(),
        }
    }

    /// Read-only access to the underlying ChunkTracker.
    pub fn chunks(&self) -> &ChunkTracker {
        &self.chunks
    }

    /// Consume the PieceTracker, requeuing any in-flight pieces.
    ///
    /// This is used when pausing a torrent - any pieces that were being downloaded
    /// need to be put back in the queue so they can be re-downloaded on resume.
    pub fn into_chunks(mut self) -> ChunkTracker {
        // Requeue all in-flight pieces so they'll be re-downloaded on resume
        for piece in self.inflight.into_keys() {
            self.chunks.mark_piece_broken_if_not_have(piece);
        }
        self.chunks
    }

    // === PIECE ACQUISITION ===

    /// Attempt to acquire a piece for the requesting peer.
    ///
    /// The acquisition strategy is:
    /// 1. Try to steal a piece from a peer that's 10x slower
    /// 2. Try to reserve a piece from the queue (priority pieces first)
    /// 3. Try to steal a piece from a peer that's 3x slower
    ///
    /// If `Stolen` is returned, the caller MUST call `peers.on_steal()` to notify
    /// the old peer and update counters.
    pub fn acquire_piece<I, P, S>(&mut self, mut req: AcquireRequest<I, P, S>) -> AcquireResult
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        if let Some(result) = self.help_waited(&req) {
            return result;
        }

        if let Some(piece) = self.resumable_for(req.peer, &req.peer_has_piece, req.waited) {
            return AcquireResult::Resumed(piece);
        }

        // 1. Try steal with 10x threshold (very slow peer)
        if let Some(result) = self.try_steal(&req, 10.0) {
            return result;
        }

        let urgent: Vec<ValidPieceIndex> = (&mut req.priority_pieces).take(URGENT_PIECES).collect();
        for piece in urgent.iter().copied() {
            if self.chunks.is_piece_have(piece) || !(req.peer_has_piece)(piece) {
                continue;
            }
            let Some(info) = self.inflight.get(&piece) else {
                return self.reserve_piece(piece, req.peer);
            };
            if info.has_worker(req.peer) {
                continue;
            }
            let (started, from_peer) = (info.started, info.peer);
            let scale = (self.chunks.get_lengths().piece_length(piece) as f64 / URGENT_REFERENCE_PIECE as f64).max(1.0);
            let patience = match req.peer_avg_time {
                Some(avg) => URGENT_STEAL_AFTER.mul_f64(scale).max(avg.mul_f64(2.0)),
                None => URGENT_STEAL_UNKNOWN_AFTER.mul_f64(scale),
            };
            if started.elapsed() >= patience && (req.can_steal)(piece) {
                if let Some(info) = self.inflight.get_mut(&piece) {
                    info.forget_worker(from_peer);
                    info.peer = req.peer;
                    info.started = Instant::now();
                    return AcquireResult::Stolen { piece, from_peer };
                }
            }
        }

        // 2. Try reserve from priority_pieces then queued pieces
        // First check priority pieces that aren't already downloaded or in-flight
        for piece in &mut req.priority_pieces {
            if !self.chunks.is_piece_have(piece)
                && !self.inflight.contains_key(&piece)
                && (req.peer_has_piece)(piece)
            {
                return self.reserve_piece(piece, req.peer);
            }
        }

        // Then check naturally ordered queued pieces
        // Note: iter_queued_pieces only returns pieces in queue_pieces (not in-flight)
        let mut queued: Vec<_> = self
            .chunks
            .iter_queued_pieces(req.file_priorities, req.file_infos)
            .collect();
        if let Some(from) = req.queue_from {
            let (ahead, behind): (Vec<_>, Vec<_>) = queued.into_iter().partition(|p| p.get() >= from.get());
            queued = ahead.into_iter().chain(behind).collect();
        }

        for piece in queued {
            if (req.peer_has_piece)(piece) {
                return self.reserve_piece(piece, req.peer);
            }
        }

        // 3. Try steal with 3x threshold (moderately slow peer)
        if let Some(result) = self.try_steal(&req, 3.0) {
            return result;
        }

        AcquireResult::NoneAvailable
    }

    /// Reserve a piece: remove from queue, add to inflight.
    fn reserve_piece(&mut self, piece: ValidPieceIndex, peer: PeerHandle) -> AcquireResult {
        self.chunks.reserve_needed_piece(piece);
        self.inflight.insert(piece, InflightPiece::new(peer));
        AcquireResult::Reserved(piece)
    }

    fn help_waited<I, P, S>(&mut self, req: &AcquireRequest<I, P, S>) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        for piece in req.waited.iter().copied() {
            if self.chunks.is_piece_have(piece) || !(req.peer_has_piece)(piece) {
                continue;
            }
            let Some(info) = self.inflight.get(&piece) else {
                if self.chunks.is_piece_queued(piece) {
                    return Some(self.reserve_piece(piece, req.peer));
                }
                continue;
            };
            if self.claimable_chunk(piece, req.peer, true).is_none() {
                continue;
            }
            if info.has_worker(req.peer) {
                return Some(AcquireResult::Resumed(piece));
            }
            if !info.joinable(req.peer) {
                continue;
            }
            if let Some(info) = self.inflight.get_mut(&piece) {
                info.helpers.push(req.peer);
                return Some(AcquireResult::Helping(piece));
            }
        }
        None
    }

    pub fn waited_needs_help<P: Fn(ValidPieceIndex) -> bool>(
        &self,
        waited: &[ValidPieceIndex],
        current: ValidPieceIndex,
        peer: PeerHandle,
        peer_has_piece: P,
    ) -> bool {
        waited.iter().copied().any(|piece| {
            if piece == current || self.chunks.is_piece_have(piece) || !peer_has_piece(piece) {
                return false;
            }
            match self.inflight.get(&piece) {
                None => self.chunks.is_piece_queued(piece),
                Some(info) => info.joinable(peer) && self.claimable_chunk(piece, peer, true).is_some(),
            }
        })
    }

    fn resumable_for<P: Fn(ValidPieceIndex) -> bool>(
        &self,
        peer: PeerHandle,
        peer_has_piece: &P,
        waited: &[ValidPieceIndex],
    ) -> Option<ValidPieceIndex> {
        self.inflight
            .iter()
            .filter(|(_, info)| info.has_worker(peer) && (!info.helpers.is_empty() || (info.peer == peer && info.touched)))
            .map(|(piece, _)| *piece)
            .find(|piece| peer_has_piece(*piece) && self.claimable_chunk(*piece, peer, waited.contains(piece)).is_some())
    }

    fn claimable_chunk(&self, piece: ValidPieceIndex, peer: PeerHandle, rush: bool) -> Option<u32> {
        let info = self.inflight.get(&piece)?;
        let limit = self.claim_limits.get(&peer).copied().unwrap_or(WAITED_CLAIMS_PER_PEER);
        if rush && info.claims.values().filter(|(p, _)| *p == peer).count() >= limit {
            return None;
        }
        let count = self.chunks.get_lengths().chunks_per_piece(piece);
        let missing = |chunk: u32| !self.chunks.is_chunk_index_downloaded(piece, chunk);
        let free = |chunk: u32| missing(chunk) && !info.claims.contains_key(&chunk);

        let cursor = info.cursors.iter().find(|(p, _)| *p == peer).map(|(_, c)| *c);
        if let Some(next) = cursor.map(|c| c + 1).filter(|c| *c < count && free(*c)) {
            return Some(next);
        }
        if info.peer == peer {
            if let Some(chunk) = (0..count).find(|c| free(*c)) {
                return Some(chunk);
            }
        } else {
            let mut best: Option<(u32, u32)> = None;
            let mut run_start = None;
            for chunk in 0..=count {
                if chunk < count && free(chunk) {
                    run_start.get_or_insert(chunk);
                    continue;
                }
                if let Some(start) = run_start.take() {
                    let len = chunk - start;
                    if best.is_none_or(|(_, l)| len > l) {
                        best = Some((start, len));
                    }
                }
            }
            if let Some((start, len)) = best {
                let someone_heads_here = start == 0 || info.claims.contains_key(&(start - 1));
                return Some(if someone_heads_here { start + len / 2 } else { start });
            }
        }

        let stale = match (rush, info.progress_at.elapsed() >= WAITED_STUCK_AFTER) {
            (true, true) => Duration::ZERO,
            (true, false) => WAITED_CLAIM_STALE_AFTER,
            _ => CLAIM_STALE_AFTER,
        };
        info.claims
            .iter()
            .filter(|(chunk, (p, at))| *p != peer && at.elapsed() >= stale && missing(**chunk))
            .min_by_key(|(_, (_, at))| *at)
            .map(|(chunk, _)| *chunk)
    }

    pub fn has_waited_claims(&self, waited: &[ValidPieceIndex], peer: PeerHandle) -> bool {
        waited.iter().any(|piece| {
            self.inflight
                .get(piece)
                .is_some_and(|info| info.claims.values().any(|(p, _)| *p == peer))
        })
    }

    pub fn forget_peer_claims(&mut self, peer: PeerHandle) -> bool {
        let mut changed = false;
        for info in self.inflight.values_mut() {
            if info.helpers.contains(&peer) {
                info.forget_worker(peer);
                changed = true;
            } else if info.peer == peer && info.claims.values().any(|(p, _)| *p == peer) {
                info.claims.retain(|_, (p, _)| *p != peer);
                info.cursors.retain(|(p, _)| *p != peer);
                changed = true;
            }
        }
        changed
    }

    pub fn describe_piece(&self, piece: ValidPieceIndex) -> String {
        if self.chunks.is_piece_have(piece) {
            return format!("{}:have", piece.get());
        }
        let Some(info) = self.inflight.get(&piece) else {
            return format!("{}:{}", piece.get(), if self.chunks.is_piece_queued(piece) { "queued" } else { "idle" });
        };
        let count = self.chunks.get_lengths().chunks_per_piece(piece);
        let missing = (0..count).filter(|c| !self.chunks.is_chunk_index_downloaded(piece, *c)).count();
        format!(
            "{}:workers={} claims={} missing={}/{} still={:.0}s",
            piece.get(),
            1 + info.helpers.len(),
            info.claims.len(),
            missing,
            count,
            info.progress_at.elapsed().as_secs_f64()
        )
    }

    pub fn set_claim_limit(&mut self, peer: PeerHandle, limit: usize) {
        self.claim_limits.insert(peer, limit.max(1));
    }

    pub fn claim_next_chunk(
        &mut self,
        piece: ValidPieceIndex,
        peer: PeerHandle,
        rush: bool,
    ) -> Option<librqbit_core::lengths::ChunkInfo> {
        if !self.inflight.get(&piece)?.has_worker(peer) {
            return None;
        }
        let chunk = self.claimable_chunk(piece, peer, rush)?;
        let info = self.inflight.get_mut(&piece)?;
        info.claims.insert(chunk, (peer, Instant::now()));
        if info.peer == peer {
            info.touched = true;
        }
        match info.cursors.iter_mut().find(|(p, _)| *p == peer) {
            Some(entry) => entry.1 = chunk,
            None => info.cursors.push((peer, chunk)),
        }
        self.chunks.get_lengths().iter_chunk_infos(piece).nth(chunk as usize)
    }

    /// Try to steal a piece from a slower peer.
    fn try_steal<I, P, S>(
        &mut self,
        req: &AcquireRequest<I, P, S>,
        threshold: f64,
    ) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        let my_avg = req.peer_avg_time?;
        let min_elapsed = Duration::from_secs_f64(my_avg.as_secs_f64() * threshold);

        // Find the slowest piece from another peer that exceeds threshold
        // and that the stealing peer actually has (can download)
        let (piece, old_peer, _) = self
            .inflight
            .iter()
            .filter(|(_, info)| !info.has_worker(req.peer))
            .filter(|(p, _)| (req.peer_has_piece)(**p))
            .map(|(p, info)| (*p, info.peer, info.started.elapsed()))
            .filter(|(_, _, elapsed)| *elapsed >= min_elapsed)
            .max_by_key(|(_, _, elapsed)| *elapsed)?;

        // Check can_steal (e.g., per_piece_lock)
        if !(req.can_steal)(piece) {
            return None;
        }

        // Update ownership (piece stays in inflight, just changes owner)
        let info = self.inflight.get_mut(&piece)?;
        info.forget_worker(old_peer);
        info.peer = req.peer;
        info.started = Instant::now();

        Some(AcquireResult::Stolen {
            piece,
            from_peer: old_peer,
        })
    }

    // === PIECE COMPLETION ===

    /// Remove piece from inflight tracking (e.g., after all chunks received).
    ///
    /// Returns download duration if piece was in-flight.
    /// Note: Does NOT mark the piece as downloaded - caller should do hash check
    /// and then call `mark_piece_hash_ok` or `mark_piece_hash_failed`.
    pub fn take_inflight(&mut self, piece: ValidPieceIndex) -> Option<Duration> {
        let inflight = self.inflight.remove(&piece)?;
        Some(inflight.started.elapsed())
    }

    /// Mark piece as downloaded after successful hash verification.
    pub fn mark_piece_hash_ok(&mut self, piece: ValidPieceIndex) {
        self.chunks.mark_piece_downloaded(piece);
    }

    /// Mark piece as failed after hash verification failure - requeues the piece.
    pub fn mark_piece_hash_failed(&mut self, piece: ValidPieceIndex) {
        self.chunks.mark_piece_broken_if_not_have(piece);
    }

    /// Release all pieces owned by a peer (on peer death).
    ///
    /// Moves all pieces owned by the peer from IN_FLIGHT back to QUEUED.
    /// Returns the number of pieces released.
    pub fn release_pieces_owned_by(&mut self, peer: PeerHandle) -> usize {
        self.claim_limits.remove(&peer);
        let mut pieces_to_release = Vec::new();
        let mut count = 0;
        for (piece, info) in self.inflight.iter_mut() {
            if info.peer == peer {
                count += 1;
                if info.helpers.is_empty() {
                    pieces_to_release.push(*piece);
                } else {
                    let heir = info.helpers.remove(0);
                    info.forget_worker(peer);
                    info.cursors.retain(|(p, _)| *p != heir);
                    info.peer = heir;
                    info.started = Instant::now();
                }
            } else if info.helpers.contains(&peer) {
                info.forget_worker(peer);
                count += 1;
            }
        }

        for piece in pieces_to_release {
            self.inflight.remove(&piece);
            self.chunks.requeue_piece_keeping_chunks(piece);
        }
        count
    }

    // === QUERIES ===

    /// Get the inflight info for a piece, if it's currently being downloaded.
    pub fn get_inflight(&self, piece: ValidPieceIndex) -> Option<&InflightPiece> {
        self.inflight.get(&piece)
    }

    /// Check if a piece is currently in-flight.
    #[allow(dead_code)]
    pub fn is_inflight(&self, piece: ValidPieceIndex) -> bool {
        self.inflight.contains_key(&piece)
    }

    /// Get the number of pieces currently in-flight.
    #[allow(dead_code)]
    pub fn inflight_count(&self) -> usize {
        self.inflight.len()
    }

    // === PASS-THROUGH METHODS ===

    /// Mark a chunk as downloaded. Returns the result indicating if the piece is complete.
    pub fn mark_chunk_downloaded(
        &mut self,
        piece: &Piece<ByteBuf<'_>>,
    ) -> Option<ChunkMarkingResult> {
        let result = self.chunks.mark_chunk_downloaded(piece);
        let lengths = self.chunks.get_lengths();
        if let Some(index) = lengths.validate_piece_index(piece.index)
            && let Some(chunk) = lengths.chunk_info_from_received_data(index, piece.begin, piece.len() as u32)
            && let Some(info) = self.inflight.get_mut(&index)
        {
            info.claims.remove(&chunk.chunk_index);
            info.progress_at = Instant::now();
        }
        result
    }

    /// Update which files are selected for download.
    pub fn update_only_files(
        &mut self,
        file_infos: &FileInfos,
        new_only_files: &HashSet<usize>,
    ) -> anyhow::Result<crate::chunk_tracker::HaveNeededSelected> {
        self.chunks.update_only_files(file_infos, new_only_files)
    }

    /// Update per-file have bytes when a piece completes. Returns remaining bytes for the file.
    pub fn update_file_have_on_piece_completed(
        &mut self,
        piece_id: ValidPieceIndex,
        file_id: usize,
        file_info: &FileInfo,
    ) -> u64 {
        self.chunks
            .update_file_have_on_piece_completed(piece_id, file_id, file_info)
    }

    pub(crate) fn forget_piece(&mut self, piece: ValidPieceIndex, file_infos: &crate::type_aliases::FileInfos) -> bool {
        !self.inflight.contains_key(&piece) && self.chunks.forget_piece(piece, file_infos)
    }

    pub(crate) fn is_piece_untouched(&self, piece: ValidPieceIndex) -> bool {
        !self.inflight.contains_key(&piece) && self.chunks.is_piece_untouched(piece)
    }

    /// Flush the have pieces bitfield to disk.
    pub fn flush_have_pieces(&mut self, flush_async: bool) -> anyhow::Result<()> {
        self.chunks.get_have_pieces_mut().flush(flush_async)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bitv::BitV as BitVTrait, type_aliases::BF};
    use librqbit_core::lengths::Lengths;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn peer(id: u8) -> PeerHandle {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, id)), 6881)
    }

    /// Create a simple ChunkTracker for testing.
    /// Creates a torrent with the specified number of pieces, all selected.
    fn make_test_chunk_tracker(num_pieces: u32) -> ChunkTracker {
        // Create a simple single-file torrent
        let piece_length = 16384u32; // 16KB pieces
        let total_length = piece_length as u64 * num_pieces as u64;

        let lengths = Lengths::new(total_length, piece_length).unwrap();

        let bf_len = lengths.piece_bitfield_bytes();

        // No pieces downloaded yet (empty have)
        let have = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());

        // All pieces selected
        let mut selected = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        for i in 0..num_pieces as usize {
            selected.set(i, true);
        }

        // Single file spanning all pieces
        let file_infos = vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: total_length,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }];

        ChunkTracker::new(have.into_dyn(), selected, lengths, &file_infos).unwrap()
    }

    fn make_test_file_infos(num_pieces: u32) -> FileInfos {
        let piece_length = 16384u64;
        vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: piece_length * num_pieces as u64,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }]
    }

    fn make_default_file_priorities(file_infos: &FileInfos) -> FilePriorities {
        (0..file_infos.len()).collect()
    }

    #[test]
    fn test_new_piece_tracker() {
        let chunks = make_test_chunk_tracker(10);
        let tracker = PieceTracker::new(chunks);
        assert_eq!(tracker.inflight_count(), 0);
    }

    #[test]
    fn test_reserve_piece_from_queue() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true, // Peer has all pieces
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        // Should reserve piece 0 (first in queue)
        match result {
            AcquireResult::Reserved(piece) => {
                assert_eq!(piece.get(), 0);
                assert!(tracker.is_inflight(piece));
                assert_eq!(tracker.inflight_count(), 1);
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_reserve_filters_by_peer_has_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer only has piece 2 and later
        // Note: iter_queued_pieces iterates in order: first, last, middle
        // So for 0..5: 0, 4, 1, 2, 3
        // With filter >= 2, we get 4 first (skips 0, takes 4)
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() >= 2,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        match result {
            AcquireResult::Reserved(piece) => {
                // Got piece 4 (first one peer has in iteration order)
                assert!(piece.get() >= 2, "Should have gotten a piece >= 2");
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_complete_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve a piece first
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Complete the piece (take_inflight + hash check + mark_piece_hash_ok)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        assert!(!tracker.is_inflight(piece));
        // Simulate successful hash check
        tracker.mark_piece_hash_ok(piece);
        assert!(tracker.chunks().is_piece_have(piece));
    }

    #[test]
    fn test_fail_piece_requeues() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert!(tracker.is_inflight(piece));

        // Fail the piece (take_inflight + hash check fails + mark_piece_hash_failed)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        // Simulate failed hash check
        tracker.mark_piece_hash_failed(piece);

        // Should no longer be in-flight
        assert!(!tracker.is_inflight(piece));
        // Should not be in have
        assert!(!tracker.chunks().is_piece_have(piece));
        // Should be back in queue - verify by trying to reserve it again
        let result2 = tracker.acquire_piece(AcquireRequest {
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p == piece, // Only has the failed piece
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        match result2 {
            AcquireResult::Reserved(p) => assert_eq!(p, piece),
            _ => panic!("Expected piece to be re-reservable after fail"),
        }
    }

    #[test]
    fn test_release_pieces_owned_by_peer() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves first two pieces (order: 0, 4, 1, 2, 3)
        // So peer A gets pieces 0 and 4
        let piece_a1 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };
        let piece_a2 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Peer B reserves next piece
        let piece_b = match tracker.acquire_piece(AcquireRequest {
            peer: peer_b,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert_eq!(tracker.inflight_count(), 3);
        assert!(tracker.is_inflight(piece_a1));
        assert!(tracker.is_inflight(piece_a2));
        assert!(tracker.is_inflight(piece_b));

        // Peer A dies
        let released = tracker.release_pieces_owned_by(peer_a);
        assert_eq!(released, 2);
        assert_eq!(tracker.inflight_count(), 1); // Only peer B's piece remains

        // Verify peer B's piece is still in-flight
        assert!(tracker.is_inflight(piece_b));
        // Verify peer A's pieces are no longer in-flight
        assert!(!tracker.is_inflight(piece_a1));
        assert!(!tracker.is_inflight(piece_a2));
    }

    #[test]
    fn test_into_chunks_requeues_inflight() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve pieces 0 and 1
        tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });
        tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        assert_eq!(tracker.inflight_count(), 2);

        // Convert back to chunks (simulates pause)
        let chunks = tracker.into_chunks();

        // Create a new tracker and verify pieces are back in queue
        let mut new_tracker = PieceTracker::new(chunks);
        let result = new_tracker.acquire_piece(AcquireRequest {
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        // Should get piece 0 again (was requeued)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 0),
            _ => panic!("Expected to reserve piece 0 after into_chunks"),
        }
    }

    #[test]
    fn test_priority_pieces_checked_first() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Priority pieces: piece 3, then piece 2
        let piece3 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(3)
            .unwrap();
        let piece2 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(2)
            .unwrap();
        let priority = vec![piece3, piece2];

        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: priority.into_iter(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        // Should get piece 3 (first priority piece)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 3),
            _ => panic!("Expected Reserved(3), got {:?}", result),
        }
    }

    #[test]
    fn test_none_available_when_no_pieces() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer has no pieces
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| false, // Peer has nothing
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        match result {
            AcquireResult::NoneAvailable => {}
            _ => panic!("Expected NoneAvailable, got {:?}", result),
        }
    }

    #[test]
    fn test_take_inflight_nonexistent_piece_returns_none() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);
        let piece = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(0)
            .unwrap();

        // Try to take a piece that's not in-flight
        let result = tracker.take_inflight(piece);
        assert!(result.is_none());
    }

    #[test]
    fn test_steal_only_pieces_peer_has() {
        // This test verifies the fix for a bug where try_steal didn't check
        // if the stealing peer actually has the piece in their bitfield.
        // Without this check, a peer could "steal" a piece they can't download,
        // leaving it stuck in inflight forever.

        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves pieces 0 and 4 (first two in iteration order)
        let piece_0 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 0);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        let piece_4 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 4);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        // Sleep briefly so pieces become stealable
        std::thread::sleep(Duration::from_millis(5));

        // Peer B tries to acquire with:
        // - Very short avg_time (1ms) so 3x threshold = 3ms < 5ms elapsed
        // - peer_has_piece returns true ONLY for piece 4, NOT piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer_b,
            peer_avg_time: Some(Duration::from_millis(1)),
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() == 4, // Peer B only has piece 4
            can_steal: |_| true,
            queue_from: None,
            waited: &[],
        });

        // Should steal piece 4 (which peer B has), NOT piece 0 (which peer B doesn't have)
        match result {
            AcquireResult::Stolen { piece, from_peer } => {
                assert_eq!(piece, piece_4, "Should steal piece 4 (the one peer B has)");
                assert_eq!(from_peer, peer_a);
                // Verify piece 0 is still owned by peer A (wasn't stolen)
                assert_eq!(tracker.get_inflight(piece_0).unwrap().peer, peer_a);
            }
            _ => panic!("Expected Stolen, got {:?}", result),
        }
    }

    fn make_multi_chunk_tracker(num_pieces: u32, chunks_per_piece: u32) -> (ChunkTracker, FileInfos) {
        let piece_length = 16384u32 * chunks_per_piece;
        let total_length = piece_length as u64 * num_pieces as u64;
        let lengths = Lengths::new(total_length, piece_length).unwrap();
        let bf_len = lengths.piece_bitfield_bytes();
        let have = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        let mut selected = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        for i in 0..num_pieces as usize {
            selected.set(i, true);
        }
        let file_infos = vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: total_length,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }];
        let tracker = ChunkTracker::new(have.into_dyn(), selected, lengths, &file_infos).unwrap();
        (tracker, file_infos)
    }

    fn acquire_urgent(tracker: &mut PieceTracker, who: PeerHandle, file_infos: &FileInfos, urgent: &[u32]) -> AcquireResult {
        let file_priorities = make_default_file_priorities(file_infos);
        let lengths = *tracker.chunks().get_lengths();
        let pieces: Vec<ValidPieceIndex> = urgent.iter().filter_map(|i| lengths.validate_piece_index(*i)).collect();
        let waited: Vec<ValidPieceIndex> = pieces.iter().copied().take(1).collect();
        tracker.acquire_piece(AcquireRequest {
            peer: who,
            peer_avg_time: None,
            priority_pieces: pieces.into_iter(),
            file_priorities: &file_priorities,
            file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: None,
            waited: &waited,
        })
    }

    fn deliver(tracker: &mut PieceTracker, piece: u32, chunk: u32) -> Option<ChunkMarkingResult> {
        let block = vec![0u8; 16384];
        tracker.mark_chunk_downloaded(&peer_binary_protocol::Piece::from_data(piece, chunk * 16384, &block))
    }

    #[test]
    fn test_helpers_split_an_urgent_piece() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 8);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0, 1]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        assert_eq!(tracker.claim_next_chunk(piece, peer(1), false).unwrap().chunk_index, 0);

        match acquire_urgent(&mut tracker, peer(3), &file_infos, &[0, 1]) {
            AcquireResult::Helping(p) => assert_eq!(p, piece),
            other => panic!("expected Helping(0), got {other:?}"),
        }
        assert_eq!(tracker.claim_next_chunk(piece, peer(3), false).unwrap().chunk_index, 4);
        assert_eq!(tracker.claim_next_chunk(piece, peer(1), false).unwrap().chunk_index, 1);
        assert_eq!(tracker.claim_next_chunk(piece, peer(3), false).unwrap().chunk_index, 5);
        assert!(tracker.claim_next_chunk(piece, peer(9), false).is_none());

        let mut claimed = vec![0, 1, 4, 5];
        while let Some(chunk) = tracker.claim_next_chunk(piece, peer(1), false) {
            claimed.push(chunk.chunk_index);
        }
        while let Some(chunk) = tracker.claim_next_chunk(piece, peer(3), false) {
            claimed.push(chunk.chunk_index);
        }
        claimed.sort();
        assert_eq!(claimed, (0..8).collect::<Vec<u32>>());

        for chunk in 0..7 {
            assert!(matches!(deliver(&mut tracker, 0, chunk), Some(ChunkMarkingResult::NotCompleted)));
        }
        assert!(matches!(deliver(&mut tracker, 0, 7), Some(ChunkMarkingResult::Completed)));
    }

    #[test]
    fn test_owner_death_hands_the_piece_to_a_helper() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 8);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        tracker.claim_next_chunk(piece, peer(1), false).unwrap();
        assert!(matches!(acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]), AcquireResult::Helping(_)));
        tracker.claim_next_chunk(piece, peer(2), false).unwrap();

        assert_eq!(tracker.release_pieces_owned_by(peer(1)), 1);
        let info = tracker.get_inflight(piece).unwrap();
        assert_eq!(info.peer, peer(2));
        assert!(info.helpers.is_empty());
        assert_eq!(tracker.claim_next_chunk(piece, peer(2), false).unwrap().chunk_index, 0);
    }

    #[test]
    fn test_a_released_piece_keeps_its_chunks() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 8);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        for _ in 0..3 {
            let chunk = tracker.claim_next_chunk(piece, peer(1), false).unwrap();
            deliver(&mut tracker, 0, chunk.chunk_index);
        }
        assert_eq!(tracker.release_pieces_owned_by(peer(1)), 1);
        assert!(!tracker.is_inflight(piece));

        match acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => assert_eq!(p, piece),
            other => panic!("expected Reserved, got {other:?}"),
        }
        assert_eq!(tracker.claim_next_chunk(piece, peer(2), false).unwrap().chunk_index, 3);
    }

    #[test]
    fn test_stale_claims_are_taken_over() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 2);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        assert!(matches!(acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]), AcquireResult::Helping(_)));
        tracker.claim_next_chunk(piece, peer(1), false).unwrap();
        tracker.claim_next_chunk(piece, peer(2), false).unwrap();
        assert!(tracker.claim_next_chunk(piece, peer(1), false).is_none());
        if let Some(info) = tracker.inflight.get_mut(&piece) {
            for (_, at) in info.claims.values_mut() {
                *at -= CLAIM_STALE_AFTER;
            }
        }
        assert_eq!(tracker.claim_next_chunk(piece, peer(1), false).unwrap().chunk_index, 1);
    }

    #[test]
    fn test_a_waited_piece_rushes_slow_claims() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 2);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        assert!(matches!(acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]), AcquireResult::Helping(_)));
        tracker.claim_next_chunk(piece, peer(1), true).unwrap();
        tracker.claim_next_chunk(piece, peer(1), true).unwrap();
        assert!(tracker.claim_next_chunk(piece, peer(2), true).is_none());
        assert!(!tracker.waited_needs_help(&[piece], tracker.chunks().get_lengths().validate_piece_index(3).unwrap(), peer(2), |_| true));
        if let Some(info) = tracker.inflight.get_mut(&piece) {
            for (_, at) in info.claims.values_mut() {
                *at -= WAITED_CLAIM_STALE_AFTER;
            }
        }
        assert!(tracker.claim_next_chunk(piece, peer(2), false).is_none());
        assert!(tracker.waited_needs_help(&[piece], tracker.chunks().get_lengths().validate_piece_index(3).unwrap(), peer(2), |_| true));
        assert!(tracker.claim_next_chunk(piece, peer(2), true).is_some());
    }

    #[test]
    fn test_a_waited_piece_comes_before_own_work() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 32);
        let mut tracker = PieceTracker::new(chunks);
        let waited = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        tracker.claim_next_chunk(waited, peer(1), true).unwrap();
        assert!(matches!(acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]), AcquireResult::Helping(_)));
        for _ in 0..WAITED_CLAIMS_PER_PEER {
            tracker.claim_next_chunk(waited, peer(2), true).unwrap();
        }
        let own = match acquire_urgent(&mut tracker, peer(2), &file_infos, &[0, 1]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        tracker.claim_next_chunk(own, peer(2), false).unwrap();
        let first = tracker.get_inflight(waited).unwrap().cursors.iter().find(|(p, _)| *p == peer(2)).unwrap().1;
        deliver(&mut tracker, 0, first);
        let current = own;
        assert!(tracker.waited_needs_help(&[waited], current, peer(2), |_| true));
        for _ in 0..3 {
            match acquire_urgent(&mut tracker, peer(2), &file_infos, &[0, 1]) {
                AcquireResult::Resumed(p) => assert_eq!(p, waited),
                other => panic!("expected the waited piece, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_a_peer_holds_few_chunks_of_a_waited_piece() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 32);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        for _ in 0..WAITED_CLAIMS_PER_PEER {
            tracker.claim_next_chunk(piece, peer(1), true).unwrap();
        }
        assert!(tracker.claim_next_chunk(piece, peer(1), true).is_none());
        deliver(&mut tracker, 0, 0);
        assert_eq!(tracker.claim_next_chunk(piece, peer(1), true).unwrap().chunk_index, WAITED_CLAIMS_PER_PEER as u32);
        assert!(tracker.claim_next_chunk(piece, peer(1), false).is_some());

        assert!(tracker.has_waited_claims(&[piece], peer(1)));
        assert!(!tracker.has_waited_claims(&[piece], peer(2)));
        tracker.set_claim_limit(peer(1), 2);
        assert!(tracker.claim_next_chunk(piece, peer(1), true).is_none());
        tracker.set_claim_limit(peer(1), 32);
        assert!(tracker.claim_next_chunk(piece, peer(1), true).is_some());
    }

    #[test]
    fn test_a_stuck_waited_piece_lets_anyone_in() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 64);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        for helper in 2..2 + WAITED_HELPERS as u8 {
            assert!(matches!(acquire_urgent(&mut tracker, peer(helper), &file_infos, &[0]), AcquireResult::Helping(_)));
            while tracker.claim_next_chunk(piece, peer(helper), true).is_some() {}
        }
        while tracker.claim_next_chunk(piece, peer(1), true).is_some() {}
        let late = peer(200);
        assert!(!matches!(acquire_urgent(&mut tracker, late, &file_infos, &[0]), AcquireResult::Helping(_)));
        if let Some(info) = tracker.inflight.get_mut(&piece) {
            info.progress_at -= WAITED_STUCK_AFTER;
        }
        assert!(matches!(acquire_urgent(&mut tracker, peer(201), &file_infos, &[0]), AcquireResult::Helping(_)));
        assert!(tracker.claim_next_chunk(piece, peer(201), true).is_some());
    }

    #[test]
    fn test_a_choked_peer_gives_back_its_claims() {
        let (chunks, file_infos) = make_multi_chunk_tracker(4, 8);
        let mut tracker = PieceTracker::new(chunks);
        let piece = match acquire_urgent(&mut tracker, peer(1), &file_infos, &[0]) {
            AcquireResult::Reserved(p) => p,
            other => panic!("expected Reserved, got {other:?}"),
        };
        tracker.claim_next_chunk(piece, peer(1), true).unwrap();
        assert!(matches!(acquire_urgent(&mut tracker, peer(2), &file_infos, &[0]), AcquireResult::Helping(_)));
        tracker.claim_next_chunk(piece, peer(2), true).unwrap();
        assert!(tracker.forget_peer_claims(peer(2)));
        assert!(tracker.get_inflight(piece).unwrap().helpers.is_empty());
        assert!(tracker.forget_peer_claims(peer(1)));
        assert_eq!(tracker.claim_next_chunk(piece, peer(1), true).unwrap().chunk_index, 0);
        assert!(tracker.describe_piece(piece).contains("workers=1"));
    }

    #[test]
    fn test_queue_starts_at_the_stream() {
        let (chunks, file_infos) = make_multi_chunk_tracker(10, 1);
        let mut tracker = PieceTracker::new(chunks);
        let file_priorities = make_default_file_priorities(&file_infos);
        let lengths = *tracker.chunks().get_lengths();
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: lengths.validate_piece_index(6),
            waited: &[],
        });
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 9),
            other => panic!("expected the last piece first, got {other:?}"),
        }
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
            queue_from: lengths.validate_piece_index(6),
            waited: &[],
        });
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 6),
            other => panic!("expected piece 6, got {other:?}"),
        }
    }
}
