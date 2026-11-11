const fs = require("fs");

const [file, version, fromPrefix, toPrefix] = process.argv.slice(2);
const required = (process.env.KINUZA_PLATFORMS ?? "windows-x86_64,linux-x86_64,linux-x86_64-deb,linux-x86_64-rpm")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const families = [...new Set(required.map((name) => name.split("-").slice(0, 2).join("-")))];

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

const known = manifest.platforms ?? {};
for (const name of required) {
  if (!known[name]) fail(`latest.json has no ${name} entry.`);
}

const platforms = Object.entries(known).filter(([name]) => families.some((family) => name.startsWith(family)));
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

const expectations = [
  ["windows-x86_64", /\.exe$/],
  ["linux-x86_64-deb", /\.deb$/],
  ["linux-x86_64-rpm", /\.rpm$/],
  ["linux-x86_64", /\.AppImage$/],
];
for (const [name, pattern] of expectations) {
  const entry = known[name];
  if (entry && !pattern.test(decodeURIComponent(entry.url.split("/").pop()))) fail(`${name} points to a file of the wrong kind: ${entry.url}`);
}

if (fromPrefix && toPrefix) fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
process.stdout.write([...installers].join("\n"));
