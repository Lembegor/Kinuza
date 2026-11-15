use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::AppState;

const GENRE: u8 = 1;
const KEYWORD: u8 = 2;
const TAG: u8 = 3;
const DIRECTOR: u8 = 4;
const WRITER: u8 = 5;
const LEAD: u8 = 6;
const CAST: u8 = 7;
const COMPOSER: u8 = 8;
const CAMERA: u8 = 9;
const COMPANY: u8 = 10;
const NETWORK: u8 = 11;
const COUNTRY: u8 = 12;
const DECADE: u8 = 13;
const LANGUAGE: u8 = 14;
const STEM: u8 = 15;
const COLLECTION: u8 = 16;
const KIND: u8 = 17;
const LENGTH: u8 = 18;

const LEAD_CAST: usize = 3;
const POSTING_LIMIT: usize = 400;
const RESTART: f32 = 0.2;
const PUSH_EPSILON: f32 = 2e-6;
const PUSH_BUDGET: usize = 400_000;
const RECOMMENDATION_LINK: f32 = 2.2;
const ANIME_LINK: f32 = 1.8;
const CENTROID_FEATURES: usize = 60;
const CONTENT_FEATURES: usize = 24;
const CONTENT_POOL: usize = 6000;
const CANDIDATES_PER_CLUSTER: usize = 180;
const VECTOR_LIMIT: usize = 24;
const NEAREST_LIMIT: usize = 4;
const SHARED_LIMIT: usize = 4;
const MAX_CLUSTERS: usize = 6;
const FEWEST_FOR_CLUSTERS: usize = 6;
const SEED_LIMIT: usize = 300;
const SILHOUETTE_FLOOR: f32 = 0.01;
const CLUSTER_COST: f32 = 0.004;
const SMALL_CLUSTER_SHARE: f32 = 0.08;
const PRIOR_VOTES: f32 = 1500.0;
const TMDB_VOTE_SCALE: f32 = 3.0;
const ANILIST_VOTES: f32 = 1500.0;
const SHIKIMORI_VOTES: f32 = 800.0;
const TYPICAL_RATING: f32 = 6.4;
const GENRE_MEAN_VOTES: u32 = 50;
const IMDB_RECORD: usize = 9;
const DEFAULT_MIN_VOTES: u32 = 30;
const FILTER_POOL: usize = 400;

const ANIMATION: u32 = 16;

fn group_weight(group: u8) -> f32 {
    match group {
        GENRE => 1.0,
        KEYWORD => 1.0,
        TAG => 1.0,
        DIRECTOR => 0.9,
        WRITER => 0.7,
        LEAD => 0.6,
        CAST => 0.4,
        COMPOSER => 0.3,
        CAMERA => 0.25,
        COMPANY => 0.35,
        NETWORK => 0.3,
        COUNTRY => 0.4,
        DECADE => 0.35,
        LANGUAGE => 0.5,
        STEM => 0.3,
        COLLECTION => 1.2,
        KIND => 0.3,
        LENGTH => 0.2,
        _ => 0.0,
    }
}

fn cluster_weight(group: u8) -> f32 {
    match group {
        GENRE => 1.6,
        LANGUAGE => 1.2,
        TAG => 1.0,
        KEYWORD => 0.8,
        COLLECTION => 0.8,
        COUNTRY => 0.6,
        KIND => 0.6,
        DIRECTOR => 0.4,
        DECADE => 0.3,
        WRITER => 0.3,
        LENGTH => 0.2,
        _ => 0.0,
    }
}

fn links_titles(group: u8) -> bool {
    matches!(group, KEYWORD | TAG | DIRECTOR | WRITER | LEAD | CAST | COMPOSER | CAMERA | COMPANY | NETWORK | COLLECTION)
}

fn group_name(group: u8) -> &'static str {
    match group {
        GENRE => "genre",
        KEYWORD => "keyword",
        TAG => "tag",
        DIRECTOR => "director",
        WRITER => "writer",
        LEAD | CAST => "cast",
        COMPOSER => "composer",
        CAMERA => "camera",
        COMPANY => "company",
        NETWORK => "network",
        COLLECTION => "collection",
        _ => "",
    }
}

fn code(group: u8, value: u64) -> u64 {
    (u64::from(group) << 56) | (value & 0x00FF_FFFF_FFFF_FFFF)
}

fn group_of(code: u64) -> u8 {
    (code >> 56) as u8
}

fn value_of(code: u64) -> u64 {
    code & 0x00FF_FFFF_FFFF_FFFF
}

fn hashed(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn canonical_genres(genres: &[u32]) -> Vec<u32> {
    let mut found = Vec::new();
    for genre in genres {
        let parts: &[u32] = match genre {
            10759 => &[28, 12],
            10765 => &[878, 14],
            10768 => &[10752],
            _ => std::slice::from_ref(genre),
        };
        for part in parts {
            if !found.contains(part) {
                found.push(*part);
            }
        }
    }
    found
}

fn length_bucket(tv: bool, runtime: u32, episodes: u32) -> Option<u64> {
    if runtime == 0 {
        return None;
    }
    let bucket = if tv {
        let format = if episodes > 0 && episodes <= 12 { 10 } else { 20 };
        format
            + match runtime {
                0..=17 => 1,
                18..=35 => 2,
                36..=50 => 3,
                _ => 4,
            }
    } else {
        match runtime {
            0..=89 => 1,
            90..=119 => 2,
            120..=149 => 3,
            _ => 4,
        }
    };
    Some(bucket)
}

#[derive(Deserialize, Default, Clone)]
pub struct Features {
    #[serde(default)]
    w: Vec<u32>,
    #[serde(default)]
    d: Vec<u32>,
    #[serde(default)]
    s: Vec<u32>,
    #[serde(default)]
    a: Vec<u32>,
    #[serde(default)]
    u: Vec<u32>,
    #[serde(default)]
    h: Vec<u32>,
    #[serde(default)]
    p: Vec<u32>,
    #[serde(default)]
    e: Vec<u32>,
    #[serde(default)]
    r: Vec<u32>,
    #[serde(default)]
    n: Vec<String>,
    #[serde(default)]
    o: Vec<String>,
    #[serde(default)]
    t: Vec<u32>,
    #[serde(default)]
    q: Vec<(u32, u32)>,
    #[serde(default)]
    m: Option<u32>,
    #[serde(default)]
    z: Option<u32>,
    #[serde(default)]
    j: Option<u32>,
    #[serde(default)]
    sa: Option<u32>,
    #[serde(default)]
    sk: Option<f32>,
}

#[derive(Deserialize)]
struct Record {
    k: String,
    id: u32,
    #[serde(default)]
    l: String,
    #[serde(default)]
    y: i32,
    #[serde(default)]
    v: f32,
    #[serde(default)]
    c: u32,
    #[serde(default)]
    g: Vec<u32>,
    #[serde(default)]
    imdb: Option<String>,
    #[serde(default)]
    mal: Option<u32>,
    #[serde(default)]
    a: Option<u8>,
    #[serde(default)]
    f: Option<Features>,
}

struct Title {
    tv: bool,
    id: u32,
    year: i32,
    votes: u32,
    rating: f32,
    fame: f32,
    adult: bool,
    anime: bool,
    runtime: u16,
    episodes: u16,
    collection: u32,
    imdb: u32,
    anilist: u8,
    shikimori: f32,
    language: String,
    countries: Vec<String>,
    genres: Vec<u32>,
    people: Vec<u32>,
    features: Vec<u32>,
    links: Vec<(u32, f32)>,
}

impl Title {
    fn key_text(&self) -> String {
        format!("{}:{}", if self.tv { "tv" } else { "movie" }, self.id)
    }
}

struct FeatureNode {
    code: u64,
    idf: f32,
    postings: Vec<u32>,
}

#[derive(Default)]
struct Pending {
    title: Option<Title>,
    codes: Vec<u64>,
    recommendations: Vec<u32>,
    anime_links: Vec<(u32, u32)>,
}

fn title_codes(tv: bool, year: i32, language: &str, genres: &[u32], features: &Features) -> Vec<u64> {
    let mut codes = Vec::new();
    for genre in genres {
        codes.push(code(GENRE, u64::from(*genre)));
    }
    for keyword in &features.w {
        codes.push(code(KEYWORD, u64::from(*keyword)));
    }
    for tag in &features.t {
        codes.push(code(TAG, u64::from(*tag)));
    }
    for person in &features.d {
        codes.push(code(DIRECTOR, u64::from(*person)));
    }
    for person in &features.s {
        codes.push(code(WRITER, u64::from(*person)));
    }
    for (order, person) in features.a.iter().enumerate() {
        codes.push(code(if order < LEAD_CAST { LEAD } else { CAST }, u64::from(*person)));
    }
    for person in &features.u {
        codes.push(code(COMPOSER, u64::from(*person)));
    }
    for person in &features.h {
        codes.push(code(CAMERA, u64::from(*person)));
    }
    for company in &features.p {
        codes.push(code(COMPANY, u64::from(*company)));
    }
    for network in &features.e {
        codes.push(code(NETWORK, u64::from(*network)));
    }
    for country in &features.n {
        codes.push(code(COUNTRY, hashed(country)));
    }
    for stem in &features.o {
        codes.push(code(STEM, hashed(stem)));
    }
    if let Some(collection) = features.j {
        codes.push(code(COLLECTION, u64::from(collection)));
    }
    if year > 0 {
        codes.push(code(DECADE, (year / 10) as u64));
    }
    if !language.is_empty() {
        codes.push(code(LANGUAGE, hashed(language)));
    }
    codes.push(code(KIND, u64::from(tv)));
    if let Some(bucket) = length_bucket(tv, features.m.unwrap_or(0), features.z.unwrap_or(0)) {
        codes.push(code(LENGTH, bucket));
    }
    codes.sort_unstable();
    codes.dedup();
    codes
}

fn catalog_key(tv: bool, id: u32) -> i64 {
    i64::from(id) * 2 + i64::from(tv)
}

pub struct TasteIndex {
    version: u64,
    titles: Vec<Title>,
    by_key: HashMap<i64, u32>,
    nodes: Vec<FeatureNode>,
    by_code: HashMap<u64, u32>,
    genre_means: HashMap<u32, f32>,
    fames: Vec<f32>,
    imdb: Vec<u8>,
}

impl TasteIndex {
    pub fn build(version: u64, rows: &mut dyn Iterator<Item = (f64, String)>, imdb: Vec<u8>) -> TasteIndex {
        let mut pending: Vec<Pending> = Vec::new();
        for (fame, raw) in rows {
            let Ok(record) = serde_json::from_str::<Record>(&raw) else { continue };
            let Some(features) = record.f else { continue };
            let tv = match record.k.as_str() {
                "t" => true,
                "m" => false,
                _ => continue,
            };
            let genres = canonical_genres(&record.g);
            let anime = record.mal.is_some() || (record.g.contains(&ANIMATION) && record.l == "ja");
            let codes = title_codes(tv, record.y, &record.l, &genres, &features);
            let mut people: Vec<u32> = features.d.iter().chain(features.s.iter()).chain(features.a.iter().take(LEAD_CAST)).copied().collect();
            people.dedup();
            let title = Title {
                tv,
                id: record.id,
                year: record.y,
                votes: record.c,
                rating: record.v,
                fame: fame as f32,
                adult: record.a.is_some(),
                anime,
                runtime: features.m.unwrap_or(0).min(u32::from(u16::MAX)) as u16,
                episodes: features.z.unwrap_or(0).min(u32::from(u16::MAX)) as u16,
                collection: features.j.unwrap_or(0),
                imdb: record.imdb.as_deref().and_then(|text| text.strip_prefix("tt")).and_then(|digits| digits.parse().ok()).unwrap_or(0),
                anilist: features.sa.unwrap_or(0).min(100) as u8,
                shikimori: features.sk.unwrap_or(0.0),
                language: record.l.clone(),
                countries: features.n.clone(),
                genres,
                people,
                features: Vec::new(),
                links: Vec::new(),
            };
            pending.push(Pending { title: Some(title), codes, recommendations: features.r.clone(), anime_links: features.q.clone() });
        }

        let mut by_key = HashMap::with_capacity(pending.len());
        for (index, entry) in pending.iter().enumerate() {
            if let Some(title) = &entry.title {
                by_key.insert(catalog_key(title.tv, title.id), index as u32);
            }
        }
        let mut by_code: HashMap<u64, u32> = HashMap::new();
        let mut nodes: Vec<FeatureNode> = Vec::new();
        let mut frequency: Vec<u32> = Vec::new();
        let mut titles = Vec::with_capacity(pending.len());
        for entry in pending.iter_mut() {
            let mut title = entry.title.take().unwrap();
            let mut indices = Vec::with_capacity(entry.codes.len());
            for feature in &entry.codes {
                let index = *by_code.entry(*feature).or_insert_with(|| {
                    nodes.push(FeatureNode { code: *feature, idf: 0.0, postings: Vec::new() });
                    frequency.push(0);
                    (nodes.len() - 1) as u32
                });
                frequency[index as usize] += 1;
                indices.push(index);
            }
            indices.sort_unstable();
            title.features = indices;
            for recommendation in &entry.recommendations {
                if let Some(other) = by_key.get(&catalog_key(title.tv, *recommendation)) {
                    title.links.push((*other, RECOMMENDATION_LINK));
                }
            }
            let strongest = entry.anime_links.iter().map(|(_, votes)| *votes).max().unwrap_or(1).max(1) as f32;
            for (other, votes) in &entry.anime_links {
                if let Some(found) = by_key.get(&catalog_key(title.tv, *other)) {
                    let share = ((*votes as f32 + 1.0).ln() / (strongest + 1.0).ln()).clamp(0.1, 1.0);
                    title.links.push((*found, ANIME_LINK * share));
                }
            }
            titles.push(title);
        }
        let count = titles.len().max(1) as f32;
        for (index, node) in nodes.iter_mut().enumerate() {
            node.idf = (1.0 + count / frequency[index].max(1) as f32).ln();
        }
        for (index, title) in titles.iter().enumerate() {
            for feature in &title.features {
                let node = &mut nodes[*feature as usize];
                if links_titles(group_of(node.code)) && frequency[*feature as usize] > 1 {
                    node.postings.push(index as u32);
                }
            }
        }
        for node in nodes.iter_mut() {
            node.postings.sort_by(|a, b| titles[*b as usize].fame.total_cmp(&titles[*a as usize].fame));
            node.postings.truncate(POSTING_LIMIT);
            node.postings.shrink_to_fit();
        }

        let mut sums: HashMap<u32, (f32, u32)> = HashMap::new();
        for title in &titles {
            if title.votes < GENRE_MEAN_VOTES {
                continue;
            }
            for genre in &title.genres {
                let entry = sums.entry(*genre).or_insert((0.0, 0));
                entry.0 += title.rating;
                entry.1 += 1;
            }
        }
        let genre_means = sums.into_iter().map(|(genre, (sum, n))| (genre, sum / n.max(1) as f32)).collect();
        let mut fames: Vec<f32> = titles.iter().map(|title| title.fame).collect();
        fames.sort_by(f32::total_cmp);
        TasteIndex { version, titles, by_key, nodes, by_code, genre_means, fames, imdb }
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn len(&self) -> usize {
        self.titles.len()
    }

    fn weight_of(&self, feature: u32) -> f32 {
        let node = &self.nodes[feature as usize];
        group_weight(group_of(node.code)) * node.idf
    }

    fn vector_of(&self, title: &Title) -> Vec<(u32, f32)> {
        normalized(title.features.iter().map(|feature| (*feature, self.weight_of(*feature))).collect())
    }

    fn vector_from_codes(&self, codes: &[u64]) -> Vec<(u32, f32)> {
        let entries: Vec<(u32, f32)> =
            codes.iter().filter_map(|feature| self.by_code.get(feature).map(|index| (*index, self.weight_of(*index)))).collect();
        let mut sorted = entries;
        sorted.sort_unstable_by_key(|entry| entry.0);
        sorted.dedup_by_key(|entry| entry.0);
        normalized(sorted)
    }

    fn cluster_vector(&self, vector: &[(u32, f32)]) -> Vec<(u32, f32)> {
        normalized(
            vector
                .iter()
                .map(|(feature, weight)| (*feature, weight * cluster_weight(group_of(self.nodes[*feature as usize].code)) / group_weight(group_of(self.nodes[*feature as usize].code)).max(1e-6)))
                .filter(|(_, weight)| *weight > 0.0)
                .collect(),
        )
    }

    fn imdb_rating(&self, id: u32) -> Option<(f32, u32)> {
        if id == 0 || self.imdb.len() < IMDB_RECORD {
            return None;
        }
        let count = self.imdb.len() / IMDB_RECORD;
        let (mut low, mut high) = (0usize, count);
        while low < high {
            let middle = low + (high - low) / 2;
            let record = &self.imdb[middle * IMDB_RECORD..(middle + 1) * IMDB_RECORD];
            let found = u32::from_be_bytes([record[0], record[1], record[2], record[3]]);
            match found.cmp(&id) {
                std::cmp::Ordering::Equal => {
                    return Some((f32::from(record[4]) / 10.0, u32::from_be_bytes([record[5], record[6], record[7], record[8]])));
                }
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
            }
        }
        None
    }

    fn quality(&self, title: &Title) -> (f32, Option<f32>) {
        let prior = if title.genres.is_empty() {
            TYPICAL_RATING
        } else {
            let means: Vec<f32> = title.genres.iter().filter_map(|genre| self.genre_means.get(genre).copied()).collect();
            if means.is_empty() {
                TYPICAL_RATING
            } else {
                means.iter().sum::<f32>() / means.len() as f32
            }
        };
        let mut total = PRIOR_VOTES * prior;
        let mut votes = PRIOR_VOTES;
        if title.votes > 0 && title.rating > 0.0 {
            let weight = title.votes as f32 * TMDB_VOTE_SCALE;
            total += weight * title.rating;
            votes += weight;
        }
        let imdb = self.imdb_rating(title.imdb);
        if let Some((rating, count)) = imdb {
            total += count as f32 * rating;
            votes += count as f32;
        }
        if title.anilist > 0 {
            total += ANILIST_VOTES * f32::from(title.anilist) / 10.0;
            votes += ANILIST_VOTES;
        }
        if title.shikimori > 0.0 {
            total += SHIKIMORI_VOTES * title.shikimori;
            votes += SHIKIMORI_VOTES;
        }
        (total / votes, imdb.map(|(rating, _)| rating))
    }

    fn popularity(&self, fame: f32) -> f32 {
        let below = self.fames.partition_point(|value| *value < fame);
        below as f32 / self.fames.len().max(1) as f32
    }

    fn title_edges(&self, title: &Title) -> Vec<(usize, f32)> {
        let mut edges: Vec<(usize, f32)> = Vec::with_capacity(title.features.len() + title.links.len());
        for feature in &title.features {
            let node = &self.nodes[*feature as usize];
            if links_titles(group_of(node.code)) && !node.postings.is_empty() {
                edges.push((self.titles.len() + *feature as usize, group_weight(group_of(node.code)) * node.idf));
            }
        }
        for (other, weight) in &title.links {
            edges.push((*other as usize, *weight * 4.0));
        }
        edges
    }

    fn personalized_rank(&self, start: &[(usize, f32)]) -> HashMap<usize, f32> {
        let title_count = self.titles.len();
        let mut residual: HashMap<usize, f32> = HashMap::new();
        let mut estimate: HashMap<usize, f32> = HashMap::new();
        let mut queue: VecDeque<usize> = VecDeque::new();
        let mut queued: HashSet<usize> = HashSet::new();
        let total: f32 = start.iter().map(|(_, weight)| weight.max(0.0)).sum();
        if total <= 0.0 {
            return estimate;
        }
        for (node, weight) in start {
            if *weight <= 0.0 {
                continue;
            }
            *residual.entry(*node).or_default() += weight / total;
            if queued.insert(*node) {
                queue.push_back(*node);
            }
        }
        let degree = |node: usize| -> usize {
            if node < title_count {
                self.titles[node].features.len() + self.titles[node].links.len()
            } else {
                self.nodes[node - title_count].postings.len()
            }
            .max(1)
        };
        let mut pushes = 0;
        while let Some(node) = queue.pop_front() {
            queued.remove(&node);
            let mass = residual.remove(&node).unwrap_or(0.0);
            if mass <= 0.0 {
                continue;
            }
            pushes += 1;
            if pushes > PUSH_BUDGET {
                *estimate.entry(node).or_default() += mass;
                break;
            }
            *estimate.entry(node).or_default() += RESTART * mass;
            let spread = (1.0 - RESTART) * mass;
            let mut deliver = |target: usize, amount: f32, residual: &mut HashMap<usize, f32>, queue: &mut VecDeque<usize>| {
                let value = residual.entry(target).or_default();
                *value += amount;
                if *value > PUSH_EPSILON * degree(target) as f32 && queued.insert(target) {
                    queue.push_back(target);
                }
            };
            if node < title_count {
                let edges = self.title_edges(&self.titles[node]);
                let sum: f32 = edges.iter().map(|(_, weight)| *weight).sum();
                if sum <= 0.0 {
                    *estimate.entry(node).or_default() += spread;
                    continue;
                }
                for (target, weight) in edges {
                    deliver(target, spread * weight / sum, &mut residual, &mut queue);
                }
            } else {
                let postings = &self.nodes[node - title_count].postings;
                let sum: f32 = postings.iter().map(|title| 1.0 + self.titles[*title as usize].fame).sum();
                if sum <= 0.0 {
                    continue;
                }
                for title in postings {
                    let share = (1.0 + self.titles[*title as usize].fame) / sum;
                    deliver(*title as usize, spread * share, &mut residual, &mut queue);
                }
            }
        }
        estimate.retain(|node, _| *node < title_count);
        estimate
    }
}

fn normalized(mut entries: Vec<(u32, f32)>) -> Vec<(u32, f32)> {
    let length = entries.iter().map(|(_, weight)| weight * weight).sum::<f32>().sqrt();
    if length > 0.0 {
        for entry in entries.iter_mut() {
            entry.1 /= length;
        }
    }
    entries
}

fn cosine(a: &[(u32, f32)], b: &[(u32, f32)]) -> f32 {
    let (mut i, mut j, mut sum) = (0, 0, 0.0);
    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            std::cmp::Ordering::Equal => {
                sum += a[i].1 * b[j].1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    sum
}

fn centroid(vectors: &[(&[(u32, f32)], f32)], limit: usize) -> Vec<(u32, f32)> {
    let mut sum: HashMap<u32, f32> = HashMap::new();
    for (vector, weight) in vectors {
        for (feature, value) in vector.iter() {
            *sum.entry(*feature).or_default() += value * weight;
        }
    }
    let mut entries: Vec<(u32, f32)> = sum.into_iter().filter(|(_, value)| *value > 0.0).collect();
    entries.sort_by(|a, b| b.1.total_cmp(&a.1));
    entries.truncate(limit);
    entries.sort_unstable_by_key(|entry| entry.0);
    normalized(entries)
}

fn cluster(vectors: &[Vec<(u32, f32)>], weights: &[f32]) -> Vec<usize> {
    let count = vectors.len();
    if count < FEWEST_FOR_CLUSTERS {
        return vec![0; count];
    }
    let mut similarity = vec![vec![0.0f32; count]; count];
    for i in 0..count {
        for j in (i + 1)..count {
            let value = cosine(&vectors[i], &vectors[j]);
            similarity[i][j] = value;
            similarity[j][i] = value;
        }
    }
    let mut members: Vec<Vec<usize>> = (0..count).map(|i| vec![i]).collect();
    let mut active: Vec<bool> = vec![true; count];
    let mut linkage = similarity.clone();
    let mut snapshots: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut alive = count;
    let wanted_max = MAX_CLUSTERS.min(count / 2).max(2);
    while alive > 1 {
        let mut best = (usize::MAX, usize::MAX, f32::MIN);
        for i in 0..count {
            if !active[i] {
                continue;
            }
            for j in (i + 1)..count {
                if active[j] && linkage[i][j] > best.2 {
                    best = (i, j, linkage[i][j]);
                }
            }
        }
        let (a, b, _) = best;
        if a == usize::MAX {
            break;
        }
        let size_a = members[a].len() as f32;
        let size_b = members[b].len() as f32;
        for k in 0..count {
            if active[k] && k != a && k != b {
                let merged = (linkage[a][k] * size_a + linkage[b][k] * size_b) / (size_a + size_b);
                linkage[a][k] = merged;
                linkage[k][a] = merged;
            }
        }
        let moved = std::mem::take(&mut members[b]);
        members[a].extend(moved);
        active[b] = false;
        alive -= 1;
        if alive >= 2 && alive <= wanted_max {
            let mut labels = vec![0; count];
            let mut next = 0;
            for (index, group) in members.iter().enumerate() {
                if !active[index] {
                    continue;
                }
                for member in group {
                    labels[*member] = next;
                }
                next += 1;
            }
            snapshots.push((alive, labels));
        }
    }
    let mut best_labels = vec![0; count];
    let mut best_score = SILHOUETTE_FLOOR;
    for (clusters, labels) in snapshots {
        let score = silhouette(&similarity, &labels, clusters) - CLUSTER_COST * clusters as f32;
        if score > best_score {
            best_score = score;
            best_labels = labels;
        }
    }
    fold_small(best_labels, &similarity, weights)
}

fn silhouette(similarity: &[Vec<f32>], labels: &[usize], clusters: usize) -> f32 {
    let count = labels.len();
    let mut total = 0.0;
    for i in 0..count {
        let mut sums = vec![0.0f32; clusters];
        let mut sizes = vec![0usize; clusters];
        for j in 0..count {
            if i != j {
                sums[labels[j]] += 1.0 - similarity[i][j];
                sizes[labels[j]] += 1;
            }
        }
        let own = labels[i];
        if sizes[own] == 0 {
            continue;
        }
        let a = sums[own] / sizes[own] as f32;
        let b = (0..clusters).filter(|c| *c != own && sizes[*c] > 0).map(|c| sums[c] / sizes[c] as f32).fold(f32::MAX, f32::min);
        if b == f32::MAX {
            continue;
        }
        total += (b - a) / a.max(b).max(1e-6);
    }
    total / count.max(1) as f32
}

fn fold_small(mut labels: Vec<usize>, similarity: &[Vec<f32>], weights: &[f32]) -> Vec<usize> {
    let total: f32 = weights.iter().sum::<f32>().max(1e-6);
    loop {
        let clusters = labels.iter().copied().max().map(|max| max + 1).unwrap_or(0);
        if clusters <= 1 {
            break;
        }
        let mut weight = vec![0.0f32; clusters];
        let mut size = vec![0usize; clusters];
        for (index, label) in labels.iter().enumerate() {
            weight[*label] += weights[index];
            size[*label] += 1;
        }
        let Some(small) = (0..clusters).find(|c| size[*c] < 2 || weight[*c] / total < SMALL_CLUSTER_SHARE) else { break };
        let mut affinity = vec![0.0f32; clusters];
        let mut counts = vec![0usize; clusters];
        for (i, label) in labels.iter().enumerate() {
            if *label != small {
                continue;
            }
            for (j, other) in labels.iter().enumerate() {
                if *other != small {
                    affinity[*other] += similarity[i][j];
                    counts[*other] += 1;
                }
            }
        }
        let target = (0..clusters)
            .filter(|c| *c != small)
            .max_by(|a, b| (affinity[*a] / counts[*a].max(1) as f32).total_cmp(&(affinity[*b] / counts[*b].max(1) as f32)))
            .unwrap_or(0);
        for label in labels.iter_mut() {
            if *label == small {
                *label = target;
            }
            if *label > small {
                *label -= 1;
            }
        }
    }
    labels
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeedExtra {
    #[serde(default)]
    genres: Vec<u32>,
    #[serde(default)]
    keywords: Vec<u32>,
    #[serde(default)]
    directors: Vec<u32>,
    #[serde(default)]
    cast: Vec<u32>,
    #[serde(default)]
    recommendations: Vec<u32>,
    #[serde(default)]
    collection: Option<u32>,
    #[serde(default)]
    year: i32,
    #[serde(default)]
    language: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeedInput {
    key: String,
    weight: f32,
    #[serde(default)]
    extra: Option<SeedExtra>,
    #[serde(default)]
    keep: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    person: Option<u32>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    anime: Option<bool>,
    #[serde(default)]
    min_year: Option<i32>,
    #[serde(default)]
    max_year: Option<i32>,
    #[serde(default)]
    min_runtime: Option<u16>,
    #[serde(default)]
    max_runtime: Option<u16>,
    #[serde(default)]
    genres: Vec<u32>,
    #[serde(default)]
    without_genres: Vec<u32>,
    #[serde(default)]
    countries: Vec<String>,
    #[serde(default)]
    languages: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(default)]
    seeds: Vec<SeedInput>,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    filters: Option<Filters>,
    #[serde(default)]
    min_votes: Option<u32>,
    #[serde(default)]
    single_cluster: bool,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    avoid_people: Vec<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Near {
    key: String,
    similarity: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    group: &'static str,
    id: u64,
    weight: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    key: String,
    cluster: usize,
    ppr: f32,
    cosine: f32,
    nearest: Vec<Near>,
    negative: f32,
    quality: f32,
    imdb: Option<f32>,
    votes: u32,
    rating: f32,
    popularity: f32,
    year: i32,
    runtime: u16,
    episodes: u16,
    anime: bool,
    language: String,
    countries: Vec<String>,
    genres: Vec<u32>,
    people: Vec<u32>,
    collection: Option<u32>,
    shared: Vec<Shared>,
    vector: Vec<(u32, f32)>,
    avoided: f32,
    #[serde(skip)]
    preliminary: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSummary {
    seeds: Vec<String>,
    weight: f32,
    features: Vec<Shared>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    ready: bool,
    titles: usize,
    clusters: Vec<ClusterSummary>,
    candidates: Vec<Candidate>,
    seeds_found: usize,
    missing: Vec<String>,
    profile: Profile,
    people: Vec<FavoritePerson>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    movie: f32,
    tv: f32,
    anime: f32,
    languages: Vec<(String, f32)>,
    genres: Vec<(u32, f32)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoritePerson {
    id: u32,
    role: &'static str,
    weight: f32,
    titles: u32,
}

impl Response {
    fn empty(ready: bool) -> Response {
        Response {
            ready,
            titles: 0,
            clusters: Vec::new(),
            candidates: Vec::new(),
            seeds_found: 0,
            missing: Vec::new(),
            profile: Profile::default(),
            people: Vec::new(),
        }
    }
}

fn parse_key(key: &str) -> Option<(bool, u32)> {
    let (kind, id) = key.split_once(':')?;
    let tv = match kind {
        "tv" => true,
        "movie" => false,
        _ => return None,
    };
    Some((tv, id.parse().ok()?))
}

struct SeedVector {
    key: String,
    weight: f32,
    vector: Vec<(u32, f32)>,
    start: Vec<(usize, f32)>,
    title: Option<usize>,
    genres: Vec<u32>,
}

impl TasteIndex {
    fn seed_vector(&self, seed: &SeedInput) -> Option<SeedVector> {
        let (tv, id) = parse_key(&seed.key)?;
        if let Some(index) = self.by_key.get(&catalog_key(tv, id)) {
            let title = &self.titles[*index as usize];
            return Some(SeedVector {
                key: seed.key.clone(),
                weight: seed.weight,
                vector: self.vector_of(title),
                start: vec![(*index as usize, 1.0)],
                title: Some(*index as usize),
                genres: title.genres.clone(),
            });
        }
        let extra = seed.extra.as_ref()?;
        let features = Features {
            w: extra.keywords.clone(),
            d: extra.directors.clone(),
            a: extra.cast.clone(),
            j: extra.collection,
            ..Features::default()
        };
        let codes = title_codes(tv, extra.year, &extra.language, &canonical_genres(&extra.genres), &features);
        let vector = self.vector_from_codes(&codes);
        if vector.is_empty() {
            return None;
        }
        let mut start: Vec<(usize, f32)> = vector
            .iter()
            .filter(|(feature, _)| links_titles(group_of(self.nodes[*feature as usize].code)) && !self.nodes[*feature as usize].postings.is_empty())
            .map(|(feature, weight)| (self.titles.len() + *feature as usize, *weight))
            .collect();
        for recommendation in &extra.recommendations {
            if let Some(other) = self.by_key.get(&catalog_key(tv, *recommendation)) {
                start.push((*other as usize, 0.5));
            }
        }
        Some(SeedVector { key: seed.key.clone(), weight: seed.weight, vector, start, title: None, genres: canonical_genres(&extra.genres) })
    }

    fn passes(&self, title: &Title, filters: Option<&Filters>, min_votes: u32) -> bool {
        if title.adult || title.votes < min_votes {
            return false;
        }
        let Some(filters) = filters else { return true };
        if let Some(kind) = &filters.kind {
            if (kind == "tv") != title.tv {
                return false;
            }
        }
        if let Some(anime) = filters.anime {
            if anime != title.anime {
                return false;
            }
        }
        if filters.min_year.is_some_and(|year| title.year < year) || filters.max_year.is_some_and(|year| title.year == 0 || title.year > year) {
            return false;
        }
        if filters.min_runtime.is_some_and(|minutes| title.runtime < minutes)
            || filters.max_runtime.is_some_and(|minutes| title.runtime == 0 || title.runtime > minutes)
        {
            return false;
        }
        let genres = canonical_genres(&filters.genres);
        if !genres.iter().all(|genre| title.genres.contains(genre)) {
            return false;
        }
        if canonical_genres(&filters.without_genres).iter().any(|genre| title.genres.contains(genre)) {
            return false;
        }
        if !filters.countries.is_empty() && !filters.countries.iter().any(|country| title.countries.contains(country)) {
            return false;
        }
        if !filters.languages.is_empty() && !filters.languages.contains(&title.language) {
            return false;
        }
        true
    }

    fn shared_features(&self, a: &[(u32, f32)], b: &[(u32, f32)]) -> Vec<Shared> {
        let (mut i, mut j) = (0, 0);
        let mut found: Vec<Shared> = Vec::new();
        while i < a.len() && j < b.len() {
            match a[i].0.cmp(&b[j].0) {
                std::cmp::Ordering::Equal => {
                    let node = &self.nodes[a[i].0 as usize];
                    let name = group_name(group_of(node.code));
                    if !name.is_empty() {
                        found.push(Shared { group: name, id: value_of(node.code), weight: a[i].1 * b[j].1 });
                    }
                    i += 1;
                    j += 1;
                }
                std::cmp::Ordering::Less => i += 1,
                std::cmp::Ordering::Greater => j += 1,
            }
        }
        found.sort_by(|x, y| y.weight.total_cmp(&x.weight));
        found.truncate(SHARED_LIMIT);
        found
    }

    fn candidate(&self, index: usize, cluster: usize, ppr: f32, cosine_value: f32, vector: Vec<(u32, f32)>) -> Candidate {
        let title = &self.titles[index];
        let (quality, imdb) = self.quality(title);
        let mut top = vector.clone();
        top.sort_by(|a, b| b.1.total_cmp(&a.1));
        top.truncate(VECTOR_LIMIT);
        top.sort_unstable_by_key(|entry| entry.0);
        Candidate {
            key: title.key_text(),
            cluster,
            ppr,
            cosine: cosine_value,
            nearest: Vec::new(),
            negative: 0.0,
            quality,
            imdb,
            votes: title.votes,
            rating: title.rating,
            popularity: self.popularity(title.fame),
            year: title.year,
            runtime: title.runtime,
            episodes: title.episodes,
            anime: title.anime,
            language: title.language.clone(),
            countries: title.countries.clone(),
            genres: title.genres.clone(),
            people: title.people.clone(),
            collection: (title.collection > 0).then_some(title.collection),
            shared: Vec::new(),
            vector: top,
            avoided: 0.0,
            preliminary: 0.0,
        }
    }

    pub fn recommend(&self, request: &Request) -> Response {
        let min_votes = request.min_votes.unwrap_or(DEFAULT_MIN_VOTES);
        let limit = request.limit.unwrap_or(CANDIDATES_PER_CLUSTER);
        let filters = request.filters.as_ref();
        let mut excluded: HashSet<i64> = HashSet::new();
        for key in request.exclude.iter().chain(request.seeds.iter().filter(|seed| !seed.keep).map(|seed| &seed.key)) {
            if let Some((tv, id)) = parse_key(key) {
                excluded.insert(catalog_key(tv, id));
            }
        }
        let mut positive: Vec<SeedVector> = Vec::new();
        let mut negative: Vec<SeedVector> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let mut avoided_people: HashSet<u32> = request.avoid_people.iter().copied().collect();
        let mut genre_positive: HashMap<u32, f32> = HashMap::new();
        let mut genre_negative: HashMap<u32, (f32, u32)> = HashMap::new();
        let mut ordered: Vec<&SeedInput> = request.seeds.iter().collect();
        ordered.sort_by(|a, b| b.weight.abs().total_cmp(&a.weight.abs()));
        for seed in ordered {
            if let Some(person) = seed.person.filter(|_| seed.reason.as_deref() == Some("person")) {
                avoided_people.insert(person);
            }
            let Some(vector) = self.seed_vector(seed) else {
                if seed.weight > 0.0 {
                    missing.push(seed.key.clone());
                }
                continue;
            };
            if seed.weight > 0.0 {
                for genre in &vector.genres {
                    *genre_positive.entry(*genre).or_default() += seed.weight;
                }
            } else if seed.reason.as_deref() != Some("person") {
                let explicit = seed.reason.as_deref() == Some("genre");
                for genre in &vector.genres {
                    let entry = genre_negative.entry(*genre).or_insert((0.0, 0));
                    entry.0 += seed.weight.abs() * if explicit { 2.0 } else { 1.0 };
                    entry.1 += if explicit { 2 } else { 1 };
                }
            }
            if seed.weight > 0.0 && positive.len() < SEED_LIMIT {
                positive.push(vector);
            } else if seed.weight < 0.0 && negative.len() < SEED_LIMIT && seed.reason.as_deref() != Some("person") {
                negative.push(vector);
            }
        }
        let seeds_found = positive.len() + negative.len();
        let avoided_genres: HashMap<u32, f32> = genre_negative
            .iter()
            .filter_map(|(genre, (sum, titles))| {
                let positive_sum = genre_positive.get(genre).copied().unwrap_or(0.0);
                (*titles >= 2 && *sum > positive_sum * 1.2).then(|| (*genre, ((sum - positive_sum) / (sum + positive_sum + 0.5)).clamp(0.0, 1.0)))
            })
            .collect();
        let avoidance = |candidate: &Candidate| -> f32 {
            let genres = if candidate.genres.is_empty() {
                0.0
            } else {
                candidate.genres.iter().map(|genre| avoided_genres.get(genre).copied().unwrap_or(0.0)).sum::<f32>() / candidate.genres.len() as f32
            };
            let people = if candidate.people.iter().any(|person| avoided_people.contains(person)) { 0.5 } else { 0.0 };
            genres + people
        };
        let profile = self.profile(&positive);
        let people = self.favorite_people(&positive);

        if positive.is_empty() {
            let mut pool: Vec<(usize, f32)> = Vec::new();
            if filters.is_some() {
                for (index, title) in self.titles.iter().enumerate() {
                    if excluded.contains(&catalog_key(title.tv, title.id)) || !self.passes(title, filters, min_votes) {
                        continue;
                    }
                    let (quality, _) = self.quality(title);
                    pool.push((index, quality + (title.votes as f32 + 1.0).log10() * 0.15));
                }
                pool.sort_by(|a, b| b.1.total_cmp(&a.1));
                pool.truncate(FILTER_POOL.min(limit.max(1) * 2));
            }
            let candidates = pool
                .into_iter()
                .map(|(index, _)| {
                    let vector = self.vector_of(&self.titles[index]);
                    let mut candidate = self.candidate(index, 0, 0.0, 0.0, vector);
                    candidate.avoided = avoidance(&candidate);
                    candidate
                })
                .collect();
            return Response { ready: true, titles: self.titles.len(), clusters: Vec::new(), candidates, seeds_found, missing, profile, people };
        }

        let vectors: Vec<Vec<(u32, f32)>> = positive.iter().map(|seed| self.cluster_vector(&seed.vector)).collect();
        let weights: Vec<f32> = positive.iter().map(|seed| seed.weight).collect();
        let labels = if request.single_cluster { vec![0; positive.len()] } else { cluster(&vectors, &weights) };
        let cluster_count = labels.iter().copied().max().map(|max| max + 1).unwrap_or(1);

        let mut chosen: HashMap<usize, Candidate> = HashMap::new();
        let mut summaries = Vec::new();
        for cluster_id in 0..cluster_count {
            let members: Vec<&SeedVector> = positive.iter().zip(labels.iter()).filter(|(_, label)| **label == cluster_id).map(|(seed, _)| seed).collect();
            if members.is_empty() {
                continue;
            }
            let weighted: Vec<(&[(u32, f32)], f32)> = members.iter().map(|seed| (seed.vector.as_slice(), seed.weight)).collect();
            let center = centroid(&weighted, CENTROID_FEATURES);
            let mut start: Vec<(usize, f32)> = Vec::new();
            for seed in &members {
                let total: f32 = seed.start.iter().map(|(_, weight)| *weight).sum::<f32>().max(1e-6);
                for (node, weight) in &seed.start {
                    start.push((*node, seed.weight * weight / total));
                }
            }
            let ranks = self.personalized_rank(&start);

            let mut pool: HashMap<usize, f32> = HashMap::new();
            for (node, rank) in &ranks {
                pool.insert(*node, *rank);
            }
            let mut strongest: Vec<(u32, f32)> = center
                .iter()
                .filter(|(feature, _)| links_titles(group_of(self.nodes[*feature as usize].code)))
                .copied()
                .collect();
            strongest.sort_by(|a, b| b.1.total_cmp(&a.1));
            for (feature, _) in strongest.iter().take(CONTENT_FEATURES) {
                for title in &self.nodes[*feature as usize].postings {
                    if pool.len() >= CONTENT_POOL + ranks.len() {
                        break;
                    }
                    pool.entry(*title as usize).or_insert(0.0);
                }
            }

            let top_rank = pool.values().copied().fold(0.0f32, f32::max).max(1e-12);
            let mut scored: Vec<(usize, f32, f32, Vec<(u32, f32)>)> = Vec::new();
            for (index, rank) in pool {
                let title = &self.titles[index];
                if excluded.contains(&catalog_key(title.tv, title.id)) || !self.passes(title, filters, min_votes) {
                    continue;
                }
                let vector = self.vector_of(title);
                let similarity = cosine(&center, &vector);
                let ppr = (rank / top_rank).sqrt();
                scored.push((index, ppr, similarity, vector));
            }
            scored.sort_by(|a, b| (0.55 * b.2 + 0.45 * b.1).total_cmp(&(0.55 * a.2 + 0.45 * a.1)));
            scored.truncate(limit);
            for (index, ppr, similarity, vector) in scored {
                let mut candidate = self.candidate(index, cluster_id, ppr, similarity, vector);
                candidate.preliminary = 0.55 * similarity + 0.45 * ppr;
                let mut near: Vec<(usize, f32)> = members
                    .iter()
                    .enumerate()
                    .filter(|(_, seed)| seed.key != candidate.key)
                    .map(|(i, seed)| (i, cosine(&seed.vector, &candidate.vector)))
                    .collect();
                near.sort_by(|a, b| b.1.total_cmp(&a.1));
                if let Some((best, _)) = near.first() {
                    candidate.shared = self.shared_features(&candidate.vector, &members[*best].vector);
                }
                candidate.nearest = near
                    .iter()
                    .take(NEAREST_LIMIT)
                    .filter(|(_, similarity)| *similarity > 0.0)
                    .map(|(i, similarity)| Near { key: members[*i].key.clone(), similarity: *similarity })
                    .collect();
                let strongest_negative = negative.iter().map(|seed| seed.weight.abs()).fold(0.0f32, f32::max).max(1e-6);
                candidate.negative = negative
                    .iter()
                    .map(|seed| cosine(&seed.vector, &candidate.vector) * seed.weight.abs() / strongest_negative)
                    .fold(0.0f32, f32::max);
                candidate.avoided = avoidance(&candidate);
                match chosen.get(&index) {
                    Some(known) if known.preliminary >= candidate.preliminary => {}
                    _ => {
                        chosen.insert(index, candidate);
                    }
                }
            }

            let mut features: Vec<Shared> = center
                .iter()
                .filter_map(|(feature, weight)| {
                    let node = &self.nodes[*feature as usize];
                    let name = group_name(group_of(node.code));
                    (!name.is_empty()).then(|| Shared { group: name, id: value_of(node.code), weight: *weight })
                })
                .collect();
            features.sort_by(|a, b| b.weight.total_cmp(&a.weight));
            features.truncate(8);
            let mut seed_order: Vec<&&SeedVector> = members.iter().collect();
            seed_order.sort_by(|a, b| {
                let a_fit = cosine(&a.vector, &center) * a.weight;
                let b_fit = cosine(&b.vector, &center) * b.weight;
                b_fit.total_cmp(&a_fit)
            });
            summaries.push(ClusterSummary {
                seeds: seed_order.iter().map(|seed| seed.key.clone()).collect(),
                weight: members.iter().map(|seed| seed.weight).sum(),
                features,
            });
        }
        let mut candidates: Vec<Candidate> = chosen.into_values().collect();
        candidates.sort_by(|a, b| b.preliminary.total_cmp(&a.preliminary));
        Response { ready: true, titles: self.titles.len(), clusters: summaries, candidates, seeds_found, missing, profile, people }
    }

    fn profile(&self, positive: &[SeedVector]) -> Profile {
        let mut profile = Profile::default();
        let mut languages: HashMap<String, f32> = HashMap::new();
        let mut genres: HashMap<u32, f32> = HashMap::new();
        let mut total = 0.0;
        for seed in positive {
            for genre in &seed.genres {
                *genres.entry(*genre).or_default() += seed.weight;
            }
            let Some(index) = seed.title else { continue };
            let title = &self.titles[index];
            total += seed.weight;
            if title.tv {
                profile.tv += seed.weight;
            } else {
                profile.movie += seed.weight;
            }
            if title.anime {
                profile.anime += seed.weight;
            }
            *languages.entry(title.language.clone()).or_default() += seed.weight;
        }
        if total > 0.0 {
            profile.tv /= total;
            profile.movie /= total;
            profile.anime /= total;
        }
        let mut languages: Vec<(String, f32)> = languages.into_iter().map(|(language, weight)| (language, weight / total.max(1e-6))).collect();
        languages.sort_by(|a, b| b.1.total_cmp(&a.1));
        languages.truncate(12);
        profile.languages = languages;
        let genre_total: f32 = positive.iter().map(|seed| seed.weight).sum::<f32>().max(1e-6);
        let mut genres: Vec<(u32, f32)> = genres.into_iter().map(|(genre, weight)| (genre, weight / genre_total)).collect();
        genres.sort_by(|a, b| b.1.total_cmp(&a.1));
        profile.genres = genres;
        profile
    }

    fn favorite_people(&self, positive: &[SeedVector]) -> Vec<FavoritePerson> {
        let mut found: HashMap<(u8, u64), (f32, u32)> = HashMap::new();
        for seed in positive {
            let Some(index) = seed.title else { continue };
            for feature in &self.titles[index].features {
                let node = &self.nodes[*feature as usize];
                let group = group_of(node.code);
                if !matches!(group, DIRECTOR | WRITER | LEAD) {
                    continue;
                }
                let entry = found.entry((group, value_of(node.code))).or_insert((0.0, 0));
                entry.0 += seed.weight * if group == LEAD { 0.6 } else { 1.0 };
                entry.1 += 1;
            }
        }
        let mut people: Vec<FavoritePerson> = found
            .into_iter()
            .filter(|(_, (_, titles))| *titles >= 2)
            .map(|((group, id), (weight, titles))| FavoritePerson {
                id: id as u32,
                role: match group {
                    DIRECTOR => "director",
                    WRITER => "writer",
                    _ => "cast",
                },
                weight,
                titles,
            })
            .collect();
        people.sort_by(|a, b| b.weight.total_cmp(&a.weight));
        people.truncate(6);
        people
    }
}

static INDEX: Mutex<Option<Arc<TasteIndex>>> = Mutex::new(None);
static BUILDING: Mutex<()> = Mutex::new(());

fn read_imdb(data_dir: &Path) -> Vec<u8> {
    std::fs::read(crate::imdb::index_path(data_dir)).unwrap_or_default()
}

fn current_index(app: &AppHandle, data_dir: &Path) -> Result<Option<Arc<TasteIndex>>, String> {
    let _building = BUILDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::catalog::open_now(app);
    let version = crate::catalog::featured_version(app)?;
    let Some(version) = version else {
        tracing::info!("taste: the detailed catalog is not here yet");
        return Ok(None);
    };
    if let Some(index) = INDEX.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
        if index.version() == version {
            return Ok(Some(index.clone()));
        }
    }
    let started = std::time::Instant::now();
    let imdb = read_imdb(data_dir);
    let built = crate::catalog::with_featured_records(app, |rows| TasteIndex::build(version, rows, imdb))?;
    let Some(built) = built else { return Ok(None) };
    tracing::info!("taste: index of {} titles built in {} ms", built.len(), started.elapsed().as_millis());
    if built.len() == 0 {
        return Ok(None);
    }
    let built = Arc::new(built);
    *INDEX.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(built.clone());
    Ok(Some(built))
}

#[tauri::command]
pub async fn taste_recommend(app: AppHandle, state: State<'_, AppState>, request: Request) -> Result<Response, String> {
    let data_dir = state.data_dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(index) = current_index(&app, &data_dir)? else {
            return Ok(Response::empty(false));
        };
        let started = std::time::Instant::now();
        let response = index.recommend(&request);
        tracing::info!(
            "taste: {} seeds -> {} clusters, {} candidates in {} ms",
            request.seeds.len(),
            response.clusters.len(),
            response.candidates.len(),
            started.elapsed().as_millis()
        );
        Ok(response)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|inner| inner);
    if let Err(error) = &result {
        tracing::warn!("taste: recommendation failed: {error}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str, id: u32, votes: u32, rating: f32, genres: &[u32], features: &str) -> (f64, String) {
        (
            (f64::from(votes) + 1.0).log10(),
            format!(r#"{{"k":"{kind}","id":{id},"l":"en","y":2010,"v":{rating},"c":{votes},"g":{genres:?},"f":{features}}}"#),
        )
    }

    fn sample() -> TasteIndex {
        let rows = vec![
            record("m", 1, 5000, 8.0, &[878], r#"{"w":[100,101,102],"d":[1],"a":[10,11,12],"r":[2,3]}"#),
            record("m", 2, 4000, 7.8, &[878], r#"{"w":[100,101,103],"d":[1],"a":[10,13],"r":[1]}"#),
            record("m", 3, 3000, 7.5, &[878, 53], r#"{"w":[100,102],"d":[2],"a":[11],"r":[1,2]}"#),
            record("m", 4, 2500, 7.9, &[878], r#"{"w":[101,102,103],"d":[1],"a":[12]}"#),
            record("m", 5, 2000, 7.2, &[878], r#"{"w":[100,103],"d":[3],"a":[10]}"#),
            record("m", 6, 1800, 7.0, &[878], r#"{"w":[101],"d":[1],"a":[13]}"#),
            record("m", 11, 5000, 8.1, &[10749, 35], r#"{"w":[200,201,202],"d":[20],"a":[30,31],"r":[12]}"#),
            record("m", 12, 4500, 7.6, &[10749, 35], r#"{"w":[200,201],"d":[20],"a":[30],"r":[11]}"#),
            record("m", 13, 3500, 7.3, &[10749, 35], r#"{"w":[200,202],"d":[21],"a":[31]}"#),
            record("m", 14, 3000, 7.7, &[10749, 35], r#"{"w":[201,202],"d":[20],"a":[32]}"#),
            record("m", 15, 2800, 7.1, &[10749], r#"{"w":[200],"d":[22],"a":[30]}"#),
            record("m", 16, 2600, 6.9, &[10749, 35], r#"{"w":[202],"d":[20],"a":[33]}"#),
            record("m", 21, 40, 9.5, &[878], r#"{"w":[100,101],"d":[1]}"#),
            record("m", 22, 9000, 6.0, &[27], r#"{"w":[300],"d":[40]}"#),
        ];
        TasteIndex::build(1, &mut rows.into_iter(), Vec::new())
    }

    fn seeds(keys: &[(&str, f32)]) -> Vec<SeedInput> {
        keys.iter()
            .map(|(key, weight)| SeedInput { key: key.to_string(), weight: *weight, extra: None, keep: false, reason: None, person: None })
            .collect()
    }

    #[test]
    fn explicit_genre_dismissals_avoid_that_genre() {
        let index = sample();
        let mut list = seeds(&[("movie:1", 1.0), ("movie:2", 0.8)]);
        list.push(SeedInput { key: "movie:22".into(), weight: -0.3, extra: None, keep: false, reason: Some("genre".into()), person: None });
        let response = index.recommend(&Request { seeds: list, ..Request::default() });
        assert!(response.people.iter().any(|person| person.id == 1 && person.role == "director"));
        assert!(response.profile.movie > 0.99);
        let horror = index.recommend(&Request {
            seeds: vec![
                SeedInput { key: "movie:1".into(), weight: 1.0, extra: None, keep: false, reason: None, person: None },
                SeedInput { key: "movie:22".into(), weight: -0.3, extra: None, keep: false, reason: Some("genre".into()), person: None },
            ],
            filters: None,
            ..Request::default()
        });
        assert!(horror.candidates.iter().all(|candidate| !candidate.genres.contains(&27) || candidate.avoided > 0.0));
    }

    #[test]
    fn kept_seeds_stay_as_candidates_and_missing_ones_are_reported() {
        let index = sample();
        let mut list = seeds(&[("movie:1", 1.0), ("movie:777", 0.6)]);
        list.push(SeedInput { key: "movie:4".into(), weight: 0.1, extra: None, keep: true, reason: None, person: None });
        let response = index.recommend(&Request { seeds: list, ..Request::default() });
        assert_eq!(response.missing, vec!["movie:777".to_string()]);
        assert!(response.candidates.iter().any(|candidate| candidate.key == "movie:4"));
    }

    #[test]
    #[ignore]
    fn live_recommendations_from_the_real_catalog() {
        use std::io::BufRead;
        let path = std::env::var("KINUZA_CATALOG_FILE").expect("set KINUZA_CATALOG_FILE to a full-N.jsonl.gz");
        let reader = std::io::BufReader::new(flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap()));
        let mut names: HashMap<String, String> = HashMap::new();
        let mut rows: Vec<(f64, String)> = Vec::new();
        for line in reader.lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let kind = if value["k"] == "t" { "tv" } else { "movie" };
            let key = format!("{kind}:{}", value["id"]);
            let name = value["t"]["ru"].as_str().or(value["t"]["en"].as_str()).or(value["o"].as_str()).unwrap_or("").to_string();
            names.insert(key, name);
            if value.get("f").is_none() {
                continue;
            }
            let votes = value["c"].as_f64().unwrap_or(0.0);
            let popularity = value["p"].as_f64().unwrap_or(0.0);
            rows.push(((votes + 1.0).log10() + (popularity + 1.0).log10() / 2.0, line));
        }
        let imdb = std::env::var("KINUZA_IMDB_FILE").ok().and_then(|path| std::fs::read(path).ok()).unwrap_or_default();
        let started = std::time::Instant::now();
        let index = TasteIndex::build(1, &mut rows.into_iter(), imdb);
        println!("index: {} titles in {} ms", index.len(), started.elapsed().as_millis());
        let liked = [
            ("movie:157336", 1.0), ("movie:27205", 0.9), ("movie:155", 0.9), ("movie:603", 0.8),
            ("movie:509", 0.9), ("movie:639", 0.8), ("movie:4348", 0.9), ("movie:194", 0.8),
            ("movie:372058", 1.0), ("movie:129", 0.9), ("tv:37854", 0.8), ("tv:1429", 0.9),
            ("movie:550", -0.6),
        ];
        let started = std::time::Instant::now();
        let response = index.recommend(&Request { seeds: seeds(&liked), ..Request::default() });
        println!("recommend: {} clusters, {} candidates in {} ms, missing {:?}", response.clusters.len(), response.candidates.len(), started.elapsed().as_millis(), response.missing);
        for (number, cluster) in response.clusters.iter().enumerate() {
            let seeds: Vec<&str> = cluster.seeds.iter().map(|key| names.get(key).map(String::as_str).unwrap_or("?")).collect();
            println!("
cluster {number}: {seeds:?}");
            let mut members: Vec<&Candidate> = response.candidates.iter().filter(|candidate| candidate.cluster == number).collect();
            members.sort_by(|a, b| (b.cosine * 0.5 + b.ppr * 0.3 + (b.quality - 6.5) / 1.5 * 0.2).total_cmp(&(a.cosine * 0.5 + a.ppr * 0.3 + (a.quality - 6.5) / 1.5 * 0.2)));
            for candidate in members.iter().take(12) {
                let near = candidate.nearest.first().map(|near| names.get(&near.key).map(String::as_str).unwrap_or("?")).unwrap_or("-");
                println!(
                    "  {:<45} cos {:.2} ppr {:.2} q {:.2} pop {:.2} neg {:.2} near {} via {:?}",
                    names.get(&candidate.key).map(String::as_str).unwrap_or("?"),
                    candidate.cosine,
                    candidate.ppr,
                    candidate.quality,
                    candidate.popularity,
                    candidate.negative,
                    near,
                    candidate.shared.iter().map(|shared| shared.group).collect::<Vec<_>>()
                );
            }
        }
        let filtered = index.recommend(&Request {
            filters: Some(Filters { genres: vec![35], min_year: Some(1990), max_year: Some(1999), ..Filters::default() }),
            ..Request::default()
        });
        println!("
90s comedies: {:?}", filtered.candidates.iter().take(10).map(|candidate| names.get(&candidate.key).cloned().unwrap_or_default()).collect::<Vec<_>>());
    }

    #[test]
    fn finds_titles_linked_by_people_and_recommendations() {
        let index = sample();
        let response = index.recommend(&Request { seeds: seeds(&[("movie:1", 1.0), ("movie:2", 0.8)]), ..Request::default() });
        let keys: Vec<&str> = response.candidates.iter().map(|candidate| candidate.key.as_str()).collect();
        assert!(keys.contains(&"movie:3"));
        assert!(keys.contains(&"movie:4"));
        assert!(!keys.contains(&"movie:1"));
        let science = keys.iter().position(|key| *key == "movie:4").unwrap();
        let romance = keys.iter().position(|key| *key == "movie:12").unwrap_or(usize::MAX);
        assert!(science < romance);
        let fourth = response.candidates.iter().find(|candidate| candidate.key == "movie:4").unwrap();
        assert!(fourth.shared.iter().any(|shared| shared.group == "director" && shared.id == 1));
        assert_eq!(fourth.nearest[0].key.as_str().starts_with("movie:"), true);
    }

    #[test]
    fn splits_two_different_tastes_into_clusters() {
        let index = sample();
        let response = index.recommend(&Request {
            seeds: seeds(&[("movie:1", 1.0), ("movie:2", 0.9), ("movie:4", 0.8), ("movie:11", 1.0), ("movie:12", 0.9), ("movie:14", 0.8)]),
            ..Request::default()
        });
        assert_eq!(response.clusters.len(), 2);
        let romance = response.candidates.iter().find(|candidate| candidate.key == "movie:13").unwrap();
        let science = response.candidates.iter().find(|candidate| candidate.key == "movie:3").unwrap();
        assert_ne!(romance.cluster, science.cluster);
    }

    #[test]
    fn few_votes_do_not_beat_a_trusted_rating() {
        let index = sample();
        let (obscure, _) = index.quality(&index.titles[*index.by_key.get(&catalog_key(false, 21)).unwrap() as usize]);
        let (trusted, _) = index.quality(&index.titles[*index.by_key.get(&catalog_key(false, 1)).unwrap() as usize]);
        assert!(trusted > obscure);
    }

    #[test]
    fn negative_seeds_mark_similar_candidates() {
        let index = sample();
        let response = index.recommend(&Request {
            seeds: seeds(&[("movie:1", 1.0), ("movie:2", 0.8), ("movie:5", -1.0)]),
            ..Request::default()
        });
        let close = response.candidates.iter().find(|candidate| candidate.key == "movie:3").map(|candidate| candidate.negative).unwrap_or(0.0);
        let far = response.candidates.iter().find(|candidate| candidate.key == "movie:6").map(|candidate| candidate.negative).unwrap_or(0.0);
        assert!(close > far);
    }

    #[test]
    fn filters_without_seeds_list_matching_titles() {
        let index = sample();
        let response = index.recommend(&Request {
            filters: Some(Filters { genres: vec![10749], ..Filters::default() }),
            ..Request::default()
        });
        assert!(!response.candidates.is_empty());
        assert!(response.candidates.iter().all(|candidate| candidate.genres.contains(&10749)));
        assert_eq!(response.candidates[0].key, "movie:11");
    }

    #[test]
    fn unknown_seed_uses_its_own_features() {
        let index = sample();
        let response = index.recommend(&Request {
            seeds: vec![SeedInput {
                key: "movie:999".into(),
                weight: 1.0,
                extra: Some(SeedExtra { genres: vec![10749], keywords: vec![200, 201], directors: vec![20], ..SeedExtra::default() }),
                keep: false,
                reason: None,
                person: None,
            }],
            ..Request::default()
        });
        assert_eq!(response.seeds_found, 1);
        assert!(response.candidates.iter().take(3).any(|candidate| candidate.key == "movie:11" || candidate.key == "movie:12"));
    }
}
