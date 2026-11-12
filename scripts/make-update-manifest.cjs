const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const [folder, version, baseUrl, output] = process.argv.slice(2);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!folder || !version || !baseUrl || !output) fail("usage: make-update-manifest.cjs <signature folder> <version> <download base url> <output file>");

const kinds = [
  { pattern: /-setup\.exe$/, platforms: ["windows-x86_64", "windows-x86_64-nsis"] },
  { pattern: /\.AppImage$/, platforms: ["linux-x86_64", "linux-x86_64-appimage"] },
  { pattern: /\.deb$/, platforms: ["linux-x86_64-deb"] },
  { pattern: /\.rpm$/, platforms: ["linux-x86_64-rpm"] },
];

const signatures = fs.readdirSync(folder).filter((name) => name.endsWith(".sig"));
const platforms = {};
for (const kind of kinds) {
  const matching = signatures.filter((name) => kind.pattern.test(name.slice(0, -".sig".length)));
  if (matching.length === 0) fail(`no signed installer matches ${kind.pattern}`);
  if (matching.length > 1) fail(`several signed installers match ${kind.pattern}: ${matching.join(", ")}`);
  const installer = matching[0].slice(0, -".sig".length);
  const signature = fs.readFileSync(path.join(folder, matching[0]), "utf8").trim();
  if (signature.length < 40) fail(`${matching[0]} is empty or damaged`);
  for (const platform of kind.platforms) {
    platforms[platform] = { signature, url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(installer)}` };
  }
}

const languages = ["ru", "en", "uk"];

function versionParts(value) {
  return String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validLines(lines) {
  if (!Array.isArray(lines)) return null;
  const kept = lines.filter((line) => (typeof line === "string" && line.trim()) || (line && typeof line.heading === "string" && line.heading.trim()));
  return kept.length > 0 ? kept.map((line) => (typeof line === "string" ? line : { heading: line.heading })) : null;
}

async function changelogUpTo() {
  const file = path.join(__dirname, "..", "src", "changelog.ts");
  try {
    const { changelog } = await import(pathToFileURL(file).href);
    if (!changelog[version]) console.log(`::warning::src/changelog.ts has no ${version} entry, the update window shows the tag notes.`);
    const result = {};
    for (const [entryVersion, entry] of Object.entries(changelog)) {
      if (compareVersions(entryVersion, version) > 0) continue;
      const texts = {};
      for (const language of languages) {
        const lines = validLines(entry?.[language]);
        if (lines) texts[language] = lines;
        else if (entryVersion === version) console.log(`::warning::src/changelog.ts has no ${language} text for ${version}.`);
      }
      if (Object.keys(texts).length > 0) result[entryVersion] = texts;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.log(`::warning::src/changelog.ts could not be read: ${error.message}`);
    return null;
  }
}

changelogUpTo().then((changelog) => {
  const manifest = {
    version,
    notes: process.env.RELEASE_NOTES || `Kinuza ${version}`,
    ...(changelog ? { changelog } : {}),
    pub_date: new Date().toISOString(),
    platforms,
  };
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2));
  console.log(Object.entries(platforms).map(([name, entry]) => `${name}: ${decodeURIComponent(entry.url.split("/").pop())}`).join("\n"));
  if (changelog) console.log(`changelog: ${Object.keys(changelog).join(", ")}`);
});
