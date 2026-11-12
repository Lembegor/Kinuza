const fs = require("fs");
const path = require("path");

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

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || `Kinuza ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(output, JSON.stringify(manifest, null, 2));
console.log(Object.entries(platforms).map(([name, entry]) => `${name}: ${decodeURIComponent(entry.url.split("/").pop())}`).join("\n"));
