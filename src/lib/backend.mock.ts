import type { AppInfo, TorrentPreview, TorrentView } from "./backend";

export const mockStreamUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

const GiB = 1024 ** 3;
const storagePrefix = "kinuza-mock-store:";
const profilesKey = "kinuza-mock-profiles";
const sharedStores = new Set(["catalog-cache", "imdb-ids", "availability", "journal"]);

interface MockProfiles {
  active: string;
  ask: boolean;
  profiles: { id: string; name: string; color: string }[];
}

function mockProfiles(): MockProfiles {
  try {
    const saved = JSON.parse(localStorage.getItem(profilesKey) ?? "null") as MockProfiles | null;
    if (saved && Array.isArray(saved.profiles)) return saved;
  } catch {
    return { active: "main", ask: true, profiles: [{ id: "main", name: "", color: "blue" }] };
  }
  return { active: "main", ask: true, profiles: [{ id: "main", name: "", color: "blue" }] };
}

function saveMockProfiles(book: MockProfiles): void {
  localStorage.setItem(profilesKey, JSON.stringify(book));
}

function personalPrefix(id = mockProfiles().active): string {
  return id === "main" ? storagePrefix : `${storagePrefix}p:${id}:`;
}

function storeKey(name: string, main = false): string {
  return (main || sharedStores.has(name) ? storagePrefix : personalPrefix()) + name;
}

function profileView(book: MockProfiles) {
  return {
    active: book.active,
    ask: book.ask,
    profiles: book.profiles.map((entry) => {
      let stored: { name?: string; avatar?: string | null } = {};
      try {
        stored = JSON.parse(localStorage.getItem(personalPrefix(entry.id) + "profile") ?? "{}");
      } catch {
        stored = {};
      }
      return { id: entry.id, name: stored.name?.trim() || entry.name, color: entry.color, avatar: stored.avatar || null, main: entry.id === "main" };
    }),
  };
}

const demoCatalog = [
  {
    k: "t",
    id: 62715,
    o: "ドラゴンボール超（スーパー）",
    l: "ja",
    y: 2015,
    v: 8.2,
    c: 5415,
    p: 21.6,
    g: [16, 10759, 10765],
    t: { en: "Dragon Ball Super", ru: "Драконий жемчуг супер", uk: "Драґон Болл Супер" },
    i: { "": "/qEUrbXJ2qt4Rg84Btlx4STOhgte.jpg", ru: "/cQ3MXMOkWfj9m3t00nhqPuFWw1j.jpg", uk: "/cQ3MXMOkWfj9m3t00nhqPuFWw1j.jpg" },
    b: "/qA2UwUQbj05aeBMCuC0mHSQ4loE.jpg",
    n: ["Doragon bōru sūpā", "DBS"],
    mal: 30694,
    s: "Драконий жемчуг: Супер",
  },
  {
    k: "m",
    id: 81,
    o: "風の谷のナウシカ",
    l: "ja",
    y: 1984,
    v: 7.9,
    c: 4273,
    p: 10.3,
    g: [12, 16, 14],
    t: { en: "Warriors of the Wind", ru: "Навсикая из Долины Ветров", uk: "Навсікая з Долини Вітрів" },
    i: { "": "/tcrkfB8SRPQCgwI88hQScua6nxh.jpg", ru: "/tEPKp9uUEepiTvSsews2kcJQqsP.jpg", uk: "/yfN5EdaSwPQDEc4KXJeA9F03a7G.jpg" },
    b: "/z2jsAbXWGdJvadhovznjGg33VND.jpg",
    n: ["Kaze no Tani no Nausicaa"],
    mal: 572,
    s: "Навсикая из Долины ветров",
  },
];

const demoPreview: TorrentPreview = {
  infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Demo.Show.S01.1080p.WEB-DL",
  alreadyAdded: false,
  files: [
    ...Array.from({ length: 8 }, (_, i) => ({
      index: i,
      path: `Demo.Show.S01.1080p.WEB-DL/Demo.Show.S01E${String(i + 1).padStart(2, "0")}.1080p.WEB-DL.mkv`,
      length: 1.6 * GiB + i * 1e7,
      included: true,
      downloaded: 0,
    })),
    ...["ru", "en", "en.forced", "ger"].map((suffix, i) => ({
      index: 8 + i,
      path: `Demo.Show.S01.1080p.WEB-DL/Demo.Show.S01E01.1080p.WEB-DL.${suffix}.srt`,
      length: 60_000,
      included: true,
      downloaded: 0,
    })),
  ],
};

const demoSeriesPreview: TorrentPreview = {
  infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "Jojo's Bizarre Adventure Stardust Crusaders - Egypt Hen [BDRip 1080p]",
  alreadyAdded: false,
  files: Array.from({ length: 24 }, (_, i) => ({
    index: i,
    path: `Jojo's Bizarre Adventure Stardust Crusaders - Egypt Hen [BDRip 1080p]/[Some-Stuffs]_Jojo's_Bizarre_Adventure_Stardust_Crusaders_${String(i + 1).padStart(2, "0")}_(${i + 25})_(1920x1080_Hi10P_BDRip_FLAC).mkv`,
    length: 1.6 * GiB + i * 1e7,
    included: true,
    downloaded: 0,
  })),
};

const torrents: TorrentView[] = [];
const startedAt = Date.now();

function tick(): TorrentView[] {
  const elapsed = (Date.now() - startedAt) / 1000;
  return torrents.map((torrent) => {
    const progress = Math.min(torrent.totalBytes, elapsed * 9e6);
    const finished = progress >= torrent.totalBytes;
    return {
      ...torrent,
      progressBytes: progress,
      finished,
      downloadSpeed: finished || torrent.state === "paused" ? 0 : 9e6 + Math.sin(elapsed) * 2e6,
      uploadSpeed: torrent.uploadEnabled ? 4e5 : 0,
      peers: finished ? 3 : 24,
      files: torrent.files.map((file) => ({
        ...file,
        downloaded: Math.min(file.length, (progress / torrent.totalBytes) * file.length),
      })),
    };
  });
}

const demoTrackerItems = [
  ["UHD BDRip 2160p, HDR10] [IMAX] Dub (WinMedia, HDRezka Studio) + MVO (Jaskier) + Original Eng + Sub (Rus, Eng)", "36.59 GB", 883],
  ["BDRip 1080p] [IMAX] MVO (HDrezka) + Dub (HDrezka, WinMedia) + Original Eng + Sub (Rus, Eng)", "21.96 GB", 402],
  ["BDRip 720p] MVO (HDRezka Studio, Jaskier) + Dub (WinMedia) + Sub Rus, Eng", "8.05 GB", 310],
  ["HDRip-AVC] MVO (HDRezka Studio) + Dub (HDRezka Studio)", "2.17 GB", 204],
  ["Telesync-Rip-AVC] 2x MVO + Dub (Studio) + Sub", "1.46 GB", 12],
].map(([details, size, seeds], index) => ({
  id: String(6935000 + index),
  title: `Демо-фильм / Demo Film (Режиссёр / Director) [2026, США, приключения, драма, ${details}`,
  size,
  seeds,
  pageUrl: "https://example.com/",
}));

const demoTrackerOther = {
  id: "6935099",
  title: "Composer - Демо-фильм / Demo Film (Original Motion Picture Soundtrack) - 2026, FLAC (tracks+.cue), lossless",
  size: "581.7 MB",
  seeds: 37,
  pageUrl: "https://example.com/",
};

const demoSeriesItems = [
  ["Невероятные приключения ДжоДжо: Гонка «Стальной шар» (ТВ-7) / Steel Ball Run: JoJo no Kimyou na Bouken [ONA] [01-08 из XX] [2026, приключения, WEB-DL] [1080p] [UKR, ENG, JAP+Sub]", "8.85 GB", 75],
  ["Невероятные Приключения ДжоДжо (ТВ-1) / JoJo no Kimyou na Bouken / JoJo's Bizarre Adventure [TV] [26 из 26] [2012-2013, приключения, BDRip] [1080p] [RUS(ext), JAP+Sub]", "38.77 GB", 47],
  ["Невероятные приключения ДжоДжо: Каменный океан (ТВ-6, часть 3) / JoJo no Kimyou na Bouken: Stone Ocean [ONA] [14 из 14] [2022, BDRip] [1080p] [JAP+Sub]", "20.31 GB", 46],
  ["Невероятные приключения ДжоДжо: Каменный океан (ТВ-6, часть 1) / JoJo no Kimyou na Bouken: Stone Ocean [ONA] [12 из 12] [2021, WEB-DL] [1080p] [RUS(int), JAP+Sub]", "14.1 GB", 31],
  ["Невероятные приключения ДжоДжо: Крестоносцы звёздной пыли (ТВ-2) / JoJo no Kimyou na Bouken: Stardust Crusaders [TV] [24 из 24] [2014, BDRip] [1080p] [RUS(ext), JAP+Sub]", "30.2 GB", 22],
  ["Невероятные приключения ДжоДжо: Крестоносцы звёздной пыли - Битва в Египте (ТВ-3) / JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen [TV] [24 из 24] [2015, BDRip] [1080p]", "29.7 GB", 19],
  ["Невероятные приключения ДжоДжо: Несокрушимый алмаз (ТВ-4) / JoJo no Kimyou na Bouken: Diamond wa Kudakenai [TV] [39 из 39] [2016, BDRip] [1080p] [RUS(ext), JAP+Sub]", "52.4 GB", 15],
  ["Невероятные приключения ДжоДжо: Золотой ветер (ТВ-5) / JoJo no Kimyou na Bouken: Ougon no Kaze [TV] [39 из 39] [2018-2019, BDRip] [1080p] [JAP+Sub]", "48.9 GB", 14],
  ["Невероятные приключения ДжоДжо (ТВ-1 - ТВ-6) / JoJo no Kimyou na Bouken [TV] [190 из 190] [2012-2023, BDRip] [720p] [RUS(ext), JAP+Sub]", "120 GB", 9],
  ["JoJo no Kimyou na Bouken: Stone Ocean [ONA] [01-38 из 38] [2021-2022, WEB-DL] [1080p] [JAP+Sub]", "41 GB", 6],
].map(([title, size, seeds], index) => ({ id: String(7100000 + index), title: String(title), size: String(size), seeds: Number(seeds), pageUrl: "https://example.com/" }));

function mockGatewayFailure(): string | null {
  try {
    return localStorage.getItem("kinuza-mock-gateway");
  } catch {
    return null;
  }
}

function demoWords(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const mockCast = { active: false, paused: false, base: 0, since: 0, level: 0, volume: 22 };

const mockAccount = {
  signedIn: false,
  cancelled: false,
  revision: 0,
  backup: null as string | null,
  me: { id: 1, name: "Абеляр", email: "you@example.com", code: "ABCD2345", avatar: null, showActivity: true, invisible: false, created: 0 },
  friends: [
    { id: 2, name: "Артём", avatar: null, online: true, lastSeen: null, watching: { type: "tv", id: 45790, title: "Невероятные приключения ДжоДжо", poster: "/6kG506PdsyuHWnc5OWGl64Kd6XK.jpg", season: 2, episode: 7 } },
    { id: 3, name: "Лиза", avatar: null, online: true, lastSeen: null, watching: null },
    { id: 4, name: "Денис", avatar: null, online: false, lastSeen: Math.round(Date.now() / 1000) - 7200, watching: null },
  ] as unknown[],
  incoming: [{ id: 5, name: "Оля", avatar: null, at: Math.round(Date.now() / 1000) - 600 }] as { id: number; name: string; avatar: null; at: number }[],
  outgoing: [] as { id: number; name: string; avatar: null; at: number }[],
  card: null as unknown,
  people: [
    { id: 9, name: "Маша", avatar: null },
    { id: 10, name: "Мария Кино", avatar: null },
    { id: 11, name: "Марат", avatar: null },
    { id: 3, name: "Лиза", avatar: null },
  ],
};

export async function mockInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (command) {
    case "online_subtitles_search":
    case "shikimori_names":
    case "shikimori_search":
    case "wikidata_by_mal":
      return [];
    case "catalog_lookup": {
      const keys = (args.keys as { kind: string; id: number }[] | undefined) ?? [];
      const added = (globalThis as { __kinuzaMockCatalog?: typeof demoCatalog }).__kinuzaMockCatalog ?? [];
      return [...demoCatalog, ...added].filter((record) => keys.some((key) => key.id === record.id && key.kind.startsWith(record.k))).map((record) => JSON.stringify(record));
    }
    case "catalog_search": {
      const words = demoWords(String(args.query ?? ""));
      const added = (globalThis as { __kinuzaMockCatalog?: typeof demoCatalog }).__kinuzaMockCatalog ?? [];
      return [...demoCatalog, ...added]
        .filter((record) => {
          const names = demoWords([record.o, ...Object.values(record.t), record.s ?? "", ...record.n].join(" "));
          return words.length > 0 && words.every((word) => names.some((name) => name.startsWith(word)));
        })
        .map((record) => JSON.stringify(record));
    }
    case "tray_configure":
    case "log_write":
    case "logs_open":
    case "torrent_set_policy":
    case "write_text_file":
    case "file_pick":
    case "file_save_target":
      return null;
    case "storage_info":
      return { freeBytes: 180 * GiB, totalBytes: 930 * GiB, cacheBytes: 3.4 * GiB };
    case "stream_cache_clear":
      return 3.4 * GiB;
    case "media_tracks":
      return {
        audio: [
          { index: 0, language: "rus", codec: "ac3", channels: "5.1(side)", title: "Дубляж | Пифагор", isDefault: true, isOriginal: false },
          { index: 1, language: "rus", codec: "ac3", channels: "stereo", title: "MVO LostFilm", isDefault: false, isOriginal: false },
          { index: 2, language: "ukr", codec: "aac", channels: "stereo", title: "Двухголосая (Цікава Ідея)", isDefault: false, isOriginal: false },
          { index: 3, language: "eng", codec: "dts", channels: "5.1(side)", title: "DTS-HD MA 5.1", isDefault: false, isOriginal: true },
          { index: 4, language: "eng", codec: "ac3", channels: "stereo", title: "Commentary by the director", isDefault: false, isOriginal: false },
          { index: 5, language: "", codec: "flac", channels: "3.0", title: "", isDefault: false, isOriginal: false },
        ],
        subtitles: [
          { index: 0, language: "rus", codec: "subrip", title: "Надписи", isDefault: true, isForced: true, isText: true },
          { index: 1, language: "rus", codec: "ass", title: "Полные [AniLibria]", isDefault: false, isForced: false, isText: true },
          { index: 2, language: "eng", codec: "hdmv_pgs_subtitle", title: "SDH", isDefault: false, isForced: false, isText: false },
          { index: 3, language: "jpn", codec: "ass", title: "", isDefault: false, isForced: false, isText: true },
          { index: 4, language: "", codec: "subrip", title: "", isDefault: false, isForced: false, isText: true },
        ],
        chapters: [],
        duration: 0,
        videoCodec: "h264",
      };
    case "ffmpeg_status":
      return { installed: (globalThis as { __kinuzaMockFfmpeg?: boolean }).__kinuzaMockFfmpeg === true, installing: false, downloadedBytes: 0, totalBytes: 82 * 1024 * 1024 };
    case "imdb_rating":
      return { rating: 8.8, votes: 2_600_000 };
    case "imdb_ratings":
      return Object.fromEntries(((args.imdbIds as string[]) ?? []).map((imdbId) => [imdbId, { rating: 8.8, votes: 2_600_000 }]));
    case "gateway_status":
      return { state: mockGatewayFailure() ? "login_required" : "ready" };
    case "trackers_search": {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const custom = (globalThis as { __kinuzaMockTrackers?: unknown }).__kinuzaMockTrackers;
      if (typeof custom === "function") return (custom as (query: unknown) => unknown)(args.query);
      if (custom) return custom;
      const query = (args.query ?? {}) as { kind?: string; year?: number | null };
      if (query.kind !== "movie") return { items: [], sources: { eztv: "empty", nnm: "empty" } };
      const year = query.year ?? 2010;
      return {
        items: [
          {
            source: "yts", id: "a".repeat(40), title: `Demo Film (${year}) [${year}, BDRip 1080p] [AVC] Original (Eng)`, name: "Demo Film 1080p BluRay",
            size: "1.60 GB", sizeBytes: 1717986918, seeds: 940, leeches: 30, infoHash: "a".repeat(40), magnet: "", page: "https://example.com/", torrent: "",
            minutes: 120, season: null, episodeFirst: null, episodeLast: null,
          },
          {
            source: "nnm", id: "1870807", title: `Демо фильм / Demo Film (Режиссёр) [${year}, WEB-DLRip 720p] [AVC] Dub (HDRezka) + Original (Eng) + Sub (Rus)`,
            name: "Демо фильм / Demo Film", size: "1.46 GB", sizeBytes: 1567663063, seeds: 12, leeches: 2, infoHash: "b".repeat(40), magnet: "",
            page: "https://example.com/", torrent: "1418568", minutes: 120, season: null, episodeFirst: null, episodeLast: null,
          },
        ],
        sources: { yts: "ok", nnm: "ok" },
      };
    }
    case "account_online":
      return 37;
    case "account_status":
      return { signedIn: mockAccount.signedIn, base: "https://kinuza.channeluza.com/kinuza/account/" };
    case "account_sign_in":
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if (mockAccount.cancelled) {
        mockAccount.cancelled = false;
        throw "account_cancelled";
      }
      mockAccount.signedIn = true;
      return { account: mockAccount.me, created: true };
    case "account_cancel_sign_in":
      mockAccount.cancelled = true;
      return null;
    case "account_forget":
      mockAccount.signedIn = false;
      return null;
    case "account_sync_pull":
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { revision: mockAccount.revision, text: Number(args.known) === mockAccount.revision ? null : mockAccount.backup };
    case "account_sync_push":
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (Number(args.revision) !== mockAccount.revision) throw `sync_conflict:${mockAccount.revision}`;
      mockAccount.revision += 1;
      mockAccount.backup = String(args.text);
      return mockAccount.revision;
    case "account_call": {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!mockAccount.signedIn) throw "account_signed_out";
      const path = String(args.path);
      const body = (args.body ?? {}) as Record<string, unknown>;
      const social = () => ({ friends: mockAccount.friends, incoming: mockAccount.incoming, outgoing: mockAccount.outgoing, backupRevision: mockAccount.revision });
      if (path === "me" && args.method === "GET") return mockAccount.me;
      if (path === "me" && args.method === "PATCH") {
        const { avatar: _avatar, ...rest } = body;
        mockAccount.me = { ...mockAccount.me, ...rest };
        return mockAccount.me;
      }
      if (path === "me" && args.method === "DELETE") {
        mockAccount.signedIn = false;
        return { ok: true };
      }
      if (path.startsWith("auth/signout")) {
        mockAccount.signedIn = false;
        return { ok: true };
      }
      if (path === "presence") return body.state === "offline" ? { ok: true } : social();
      if (path === "friends/lookup") {
        const code = String(((args.query as [string, string][] | null) ?? []).find(([key]) => key === "code")?.[1] ?? "");
        if (code === mockAccount.me.code) return { id: 1, name: mockAccount.me.name, avatar: null, self: true };
        if (code !== "QWER2345") throw "friend_not_found";
        return { id: 9, name: "Маша", avatar: null, self: false };
      }
      if (path === "friends/request") {
        const person = mockAccount.people.find((item) => item.id === (typeof body.id === "number" ? body.id : 9)) ?? mockAccount.people[0];
        mockAccount.outgoing = [...mockAccount.outgoing, { id: person.id, name: person.name, avatar: null, at: Date.now() / 1000 }];
        return { result: "sent", id: person.id, ...social() };
      }
      if (path === "friends/search") {
        const query = String(((args.query as [string, string][] | null) ?? []).find(([key]) => key === "q")?.[1] ?? "").toLowerCase();
        const friendIds = new Set(mockAccount.friends.map((item) => (item as { id: number }).id));
        const outgoingIds = new Set(mockAccount.outgoing.map((item) => item.id));
        return {
          people: mockAccount.people
            .filter((item) => item.name.toLowerCase().includes(query))
            .map((item) => ({ ...item, relation: friendIds.has(item.id) ? "friend" : outgoingIds.has(item.id) ? "outgoing" : "none" })),
        };
      }
      if (path === "me/card") {
        mockAccount.card = body;
        return { ok: true };
      }
      if (path === "friends/feed") {
        const now = Date.now();
        const byId = (id: number) => mockAccount.friends.find((item) => (item as { id: number }).id === id);
        const recent = (key: string, name: string, poster: string, hoursAgo: number, extra: Record<string, unknown>) => ({
          key, name, poster, at: now - hoursAgo * 3_600_000, movie: key.startsWith("movie:"), finished: false, rating: null, episodes: 0, last: null, ...extra,
        });
        return {
          friends: [
            {
              friend: byId(2),
              updated: now / 1000,
              watching: [{ key: "tv:1396", name: "Во все тяжкие", poster: "/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg", movie: false, share: 0.4, watched: 25, total: 62 }],
              recent: [
                recent("movie:438631", "Дюна", "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg", 20, { finished: true, rating: 9 }),
                recent("tv:1429", "Атака титанов", "/hTP1DtLGFamjfu8WqjnuQdP1n4i.jpg", 50, { episodes: 3, last: { season: 4, episode: 12 } }),
              ],
            },
            {
              friend: byId(3),
              updated: now / 1000,
              watching: [],
              recent: [
                recent("movie:438631", "Дюна", "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg", 5, { finished: true, rating: 8 }),
                recent("movie:27205", "Начало", "/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg", 30, { finished: true }),
                recent("tv:94605", "Аркейн", "/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg", 70, { episodes: 2, last: { season: 2, episode: 3 } }),
              ],
            },
          ],
        };
      }
      if (path === "friends/card") {
        const id = Number(((args.query as [string, string][] | null) ?? []).find(([key]) => key === "id")?.[1]);
        const friend = mockAccount.friends.find((item) => (item as { id: number }).id === id);
        if (!friend) throw "friend_not_found";
        return { friend, hidden: id === 4, card: id === 3 ? null : mockAccount.card, updated: 0 };
      }
      if (path === "friends/accept") {
        const person = mockAccount.incoming.find((item) => item.id === body.id);
        mockAccount.incoming = mockAccount.incoming.filter((item) => item.id !== body.id);
        if (person) mockAccount.friends = [...mockAccount.friends, { id: person.id, name: person.name, avatar: null, online: true, lastSeen: null, watching: null }];
        return social();
      }
      if (path === "friends/decline") mockAccount.incoming = mockAccount.incoming.filter((item) => item.id !== body.id);
      if (path === "friends/cancel") mockAccount.outgoing = mockAccount.outgoing.filter((item) => item.id !== body.id);
      if (path === "friends/remove") mockAccount.friends = mockAccount.friends.filter((item) => (item as { id: number }).id !== body.id);
      return social();
    }
    case "trackers_inspect": {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const inspect = (globalThis as { __kinuzaMockInspect?: (id: string) => unknown }).__kinuzaMockInspect;
      if (inspect) return inspect(`${String(args.source)}:${String(args.id)}`);
      return demoPreview;
    }
    case "gateway_search":
    case "gateway_video_sizes":
    case "gateway_torrent_inspect": {
      const failure = mockGatewayFailure();
      if (failure) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        throw failure;
      }
      return mockInvoke(command.replace("gateway_", "rutracker_"), args);
    }
    case "rutracker_search": {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const recorded = (globalThis as { __kinuzaMockSearch?: (query: string, page: number) => unknown }).__kinuzaMockSearch;
      if (recorded) return recorded(String(args.query ?? ""), Number(args.page ?? 0));
      const sample = (globalThis as { __kinuzaMockTracker?: string[] }).__kinuzaMockTracker;
      if (sample) {
        if (Number(args.page ?? 0) > 0) return [];
        return sample.map((title, index) => ({
          id: String(7000000 + index),
          title,
          size: `${(1 + (index % 9) * 3.7).toFixed(2)} GB`,
          seeds: 5 + ((index * 37) % 300),
          pageUrl: "https://rutracker.org/",
        }));
      }
      if (demoWords(String(args.query ?? "")).some((word) => word === "джоджо" || word === "jojo")) {
        if (Number(args.page ?? 0) > 0) return [];
        const wanted = demoWords(String(args.query));
        return demoSeriesItems.filter((item) => {
          const words = new Set(demoWords(item.title));
          return wanted.every((word) => words.has(word));
        });
      }
      return [...demoTrackerItems.slice(0, 4), demoTrackerOther, ...demoTrackerItems.slice(4)];
    }
    case "rutracker_login_window":
      return null;
    case "rutracker_video_sizes":
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { [demoTrackerItems[3].id]: { width: 1024, height: 426 } };
    case "rutracker_torrent_inspect": {
      const inspect = (globalThis as { __kinuzaMockInspect?: (id: string) => unknown }).__kinuzaMockInspect;
      if (inspect) return inspect(String(args.id ?? ""));
      return String(args.id ?? "").startsWith("7100") ? demoSeriesPreview : demoPreview;
    }
    case "rutracker_magnet":
      return `magnet:?xt=urn:btih:${demoPreview.infoHash}`;
    case "app_info":
      return {
        version: "0.1.0",
        streamBaseUrl: "http://127.0.0.1:0/preview",
        defaultDownloadDir: "C:\\Users\\you\\Videos\\Kinuza",
        externalPlayer: "VLC",
        sessionReset: false,
        listenPort: 51413,
        updatedFrom: null,
      } satisfies AppInfo;
    case "torrent_inspect":
      await new Promise((resolve) => setTimeout(resolve, 900));
      return demoPreview;
    case "torrent_add": {
      const selected = new Set(args.files as number[]);
      const files = demoPreview.files.map((file) => ({ ...file, included: selected.has(file.index) }));
      const copy = torrents.filter((item) => item.infoHash.startsWith(demoPreview.infoHash.slice(0, 30))).length;
      torrents.push({
        infoHash: copy === 0 ? demoPreview.infoHash : `${demoPreview.infoHash.slice(0, 30)}${String(copy).padStart(10, "0")}`,
        name: copy === 0 ? demoPreview.name : `${demoPreview.name} (${copy + 1})`,
        queueOrder: copy,
        outputFolder: "C:\\Users\\you\\Videos\\Kinuza\\Demo.Show.S01.1080p.WEB-DL",
        state: "live",
        error: null,
        progressBytes: 0,
        totalBytes: files.filter((f) => f.included).reduce((sum, f) => sum + f.length, 0),
        uploadedBytes: 0,
        finished: false,
        downloadSpeed: 0,
        uploadSpeed: 0,
        peers: 0,
        files,
        uploadEnabled: true,
      });
      return null;
    }
    case "torrent_list":
      return tick();
    case "storage_report":
      return {
        downloadsDisk: { path: "C:\Users\you\Videos\Kinuza", freeBytes: 182 * GiB, totalBytes: 931 * GiB },
        dataDisk: { path: "C:\Users\you\AppData\Roaming\com.lembegor.kinuza", freeBytes: 182 * GiB, totalBytes: 931 * GiB },
        cache: [
          { infoHash: "7100004", name: "Stardust Crusaders [BDRip 1080p]", bytes: 6.4 * GiB, lastPlayed: Date.now() - 2 * 864e5, inUse: false },
          { infoHash: "cccccccccccccccccccccccccccccccccccccccc", name: "Demo Film 2026 BDRip 1080p", bytes: 3.1 * GiB, lastPlayed: Date.now() - 9 * 864e5, inUse: false },
        ],
        parts: [
          { id: "library", bytes: 17e6, clearable: false, later: false },
          { id: "ffmpeg", bytes: 153e6, clearable: true, later: false },
          { id: "imdb", bytes: 15e6, clearable: true, later: false },
          { id: "fingerprints", bytes: 7e4, clearable: true, later: false },
          { id: "logs", bytes: 2.8e5, clearable: true, later: false },
          { id: "webCache", bytes: 240e6, clearable: true, later: true },
          { id: "webData", bytes: 83e6, clearable: false, later: false },
        ],
        webCachePending: false,
      };
    case "storage_clear_part":
      return 12e6;
    case "storage_drop_cached":
    case "storage_free_download":
      return 2 * GiB;
    case "cast_devices":
      await new Promise((resolve) => setTimeout(resolve, 900));
      return [
        { id: "uuid:tv-1", name: "[TV] Samsung 7 Series (55)", maker: "Samsung Electronics", model: "UE55RU7400", address: "192.168.1.40" },
        { id: "uuid:tv-2", name: "LG webOS TV OLED65C1", maker: "LG Electronics", model: "OLED65C1", address: "192.168.1.41" },
      ];
    case "cast_start": {
      const request = args.request as { start: number; level: number; device: string };
      mockCast.active = true;
      mockCast.paused = false;
      mockCast.base = request.start;
      mockCast.since = Date.now() + 2500;
      mockCast.level = request.level;
      return { level: request.level, direct: request.level === 0, mime: "video/x-matroska", url: "http://192.168.1.10:50123/cast/x/video.mkv", address: "192.168.1.40" };
    }
    case "cast_status": {
      if (!mockCast.active) return { active: false, state: "", position: 0, reported: false, duration: null, volume: null };
      const starting = Date.now() < mockCast.since;
      const position = mockCast.paused || starting ? mockCast.base : mockCast.base + (Date.now() - mockCast.since) / 1000;
      return { active: true, state: starting ? "TRANSITIONING" : mockCast.paused ? "PAUSED_PLAYBACK" : "PLAYING", position, reported: true, duration: null, volume: mockCast.volume };
    }
    case "cast_pause":
      mockCast.base = mockCast.base + (Date.now() - mockCast.since) / 1000;
      mockCast.paused = true;
      return null;
    case "cast_play":
      mockCast.paused = false;
      mockCast.since = Date.now();
      return null;
    case "cast_volume":
      mockCast.volume = Number(args.value);
      return null;
    case "cast_seek_native":
      return false;
    case "cast_stop":
      mockCast.active = false;
      return null;
    case "torrent_set_upload": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      if (torrent) torrent.uploadEnabled = Boolean(args.enabled);
      return null;
    }
    case "torrent_exclude_files": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      const dropped = new Set(args.files as number[]);
      if (torrent) {
        if (torrent.files.filter((file) => file.included && !dropped.has(file.index)).length === 0) throw "last_file";
        torrent.files = torrent.files.map((file) => (dropped.has(file.index) ? { ...file, included: false } : file));
        torrent.totalBytes = torrent.files.filter((file) => file.included).reduce((sum, file) => sum + file.length, 0);
      }
      return null;
    }
    case "torrent_focus": {
      for (const torrent of torrents) {
        torrent.focused = torrent.infoHash === args.infoHash;
        if (torrent.focused) torrent.state = "live";
        else if (!torrent.finished && torrent.state === "live") torrent.state = "queued";
      }
      return null;
    }
    case "torrent_reorder": {
      (args.infoHashes as string[]).forEach((hash, index) => {
        const torrent = torrents.find((item) => item.infoHash === hash);
        if (torrent) torrent.queueOrder = index;
      });
      return null;
    }
    case "torrent_pause":
    case "torrent_resume": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      if (torrent) torrent.state = command === "torrent_pause" ? "paused" : "live";
      return null;
    }
    case "torrent_hold":
    case "torrent_release":
      return null;
    case "torrent_select_files": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      const wanted = new Set(args.files as number[]);
      if (torrent) {
        torrent.files = torrent.files.map((file) => (wanted.has(file.index) ? { ...file, included: true } : file));
        torrent.totalBytes = torrent.files.filter((file) => file.included).reduce((sum, file) => sum + file.length, 0);
      }
      return null;
    }
    case "torrent_delete": {
      const index = torrents.findIndex((t) => t.infoHash === args.infoHash);
      if (index >= 0) torrents.splice(index, 1);
      return null;
    }
    case "store_get": {
      const text = localStorage.getItem(storeKey(String(args.name), Boolean(args.main)));
      return text === null ? null : { text, recovered: false };
    }
    case "store_set":
      localStorage.setItem(storeKey(String(args.name), Boolean(args.main)), String(args.value));
      return null;
    case "torrent_warm":
    case "app_log":
      return null;
    case "torrent_file_map": {
      const buckets = Number(args.buckets) || 100;
      const done = Math.min(1, ((Date.now() - startedAt) / 1000) * 0.012);
      return Array.from({ length: buckets }, (_, index) => (index / buckets < done || (index > buckets * 0.6 && index < buckets * 0.66) ? 255 : index % 7 === 0 ? 128 : 0));
    }
    case "activity_append": {
      const saved = JSON.parse(localStorage.getItem(personalPrefix() + "activity") ?? "[]") as object[];
      const events = args.events as object[];
      localStorage.setItem(personalPrefix() + "activity", JSON.stringify([...saved, ...events].slice(-20000)));
      return events.length;
    }
    case "activity_read":
      return JSON.parse(localStorage.getItem(personalPrefix() + "activity") ?? "[]");
    case "activity_edit": {
      const saved = JSON.parse(localStorage.getItem(personalPrefix() + "activity") ?? "[]") as { id?: string }[];
      const upsert = args.upsert as { id?: string }[];
      const gone = new Set([...(args.remove as string[]), ...upsert.map((event) => event.id ?? "")]);
      const kept = saved.filter((event) => !gone.has(event.id ?? ""));
      localStorage.setItem(personalPrefix() + "activity", JSON.stringify([...kept, ...upsert]));
      return saved.length - kept.length;
    }
    case "activity_prune": {
      const saved = JSON.parse(localStorage.getItem(personalPrefix() + "activity") ?? "[]") as { at: number }[];
      const kept = saved.filter((event) => event.at >= Number(args.before));
      localStorage.setItem(personalPrefix() + "activity", JSON.stringify(kept));
      return saved.length - kept.length;
    }
    case "profiles_list":
      return profileView(mockProfiles());
    case "profiles_create": {
      const book = mockProfiles();
      const id = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
      book.profiles.push({ id, name: String(args.name).trim(), color: String(args.color) || "green" });
      saveMockProfiles(book);
      return id;
    }
    case "profiles_switch": {
      const book = mockProfiles();
      if (!book.profiles.some((entry) => entry.id === args.id)) throw "profiles_not_found";
      saveMockProfiles({ ...book, active: String(args.id) });
      return null;
    }
    case "profiles_update": {
      const book = mockProfiles();
      const entry = book.profiles.find((item) => item.id === args.id);
      if (!entry) throw "profiles_not_found";
      if (typeof args.name === "string") entry.name = args.name.trim();
      if (typeof args.color === "string") entry.color = args.color;
      saveMockProfiles(book);
      return null;
    }
    case "profiles_remove": {
      const book = mockProfiles();
      if (args.id === "main" || args.id === book.active) throw "profiles_cannot_remove";
      saveMockProfiles({ ...book, profiles: book.profiles.filter((entry) => entry.id !== args.id) });
      return null;
    }
    case "profiles_set_ask":
      saveMockProfiles({ ...mockProfiles(), ask: Boolean(args.ask) });
      return null;
    case "profiles_other_sources":
      return [];
    case "taste_recommend": {
      const custom = (globalThis as { __kinuzaMockTaste?: (request: unknown) => unknown }).__kinuzaMockTaste;
      if (custom) return custom(args.request);
      return { ready: false, titles: 0, clusters: [], candidates: [], seedsFound: 0, missing: [], profile: { movie: 0, tv: 0, anime: 0, languages: [], genres: [] }, people: [] };
    }
    case "take_launch_request":
      return null;
    case "associations_status":
    case "associations_set":
      return { enabled: Boolean(args.enabled), overriddenByWindows: false };
    case "file_location":
      return "C:\\Users\\you\\Videos\\Kinuza\\demo.mkv";
    case "open_external":
      return "VLC";
    default:
      return null;
  }
}
