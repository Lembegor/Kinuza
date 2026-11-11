const fs = require("fs");

const [file, version, fromPrefix, toPrefix] = process.argv.slice(2);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  fail(`latest.json is missing or is not valid JSON: ${error.message}`);
}

if (String(manifest.version).replace(/^v/, "") !== version) {
  fail(`latest.json says version ${manifest.version}, the tag says ${version}.`);
}

const platforms = Object.entries(manifest.platforms ?? {}).filter(([name]) => name.startsWith("windows-x86_64"));
if (platforms.length === 0) fail("latest.json has no Windows x64 entry.");

const installers = new Set();
for (const [name, entry] of platforms) {
  if (!entry || typeof entry.signature !== "string" || entry.signature.trim().length < 40) fail(`${name} has no signature in latest.json.`);
  if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) fail(`${name} has no download address in latest.json.`);
  if (fromPrefix && toPrefix) {
    if (!entry.url.startsWith(fromPrefix)) fail(`${name} points outside ${fromPrefix}.`);
    entry.url = toPrefix + entry.url.slice(fromPrefix.length);
  }
  installers.add(decodeURIComponent(entry.url.split("/").pop()));
}

if (fromPrefix && toPrefix) fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
process.stdout.write([...installers][0]);
