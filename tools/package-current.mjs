// Create an independent, verified local snapshot. Existing releases are never replaced.
// Usage: node tools/package-current.mjs [--config release-config.json]
// Config: { "version": "0.8.1", "destination": "releases/Arena_Fighters_v0.8.1_v001",
//           "provenance": [{ "chatId": "...", "note": "..." }] }
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RELEASE_ENTRIES = Object.freeze([
  'src', 'online', 'assets', 'public', 'tests', 'index.html', 'server.mjs',
  'package.json', 'Start-Prototype.ps1', 'README.md', 'AGENTS.md', 'ART_DIRECTION.md',
  'TOURNAMENTS.md', 'ONLINE_DUELS.md', 'DESIGN.md', 'AVATAR_PORT.md', 'CLEAN_ART.md',
  'DARK_ART.md', 'CURRENT_VERSION.md', 'FIRST_PERSON_COMBAT.md', 'tools/package-current.mjs',
  'HOSTING.md', 'render.yaml', '.node-version', 'tools/build-squarespace-embed.mjs',
]);
const HISTORY_TESTS = new Set([
  'tests/armory.test.js', 'tests/avatar.test.js', 'tests/preset-chin.test.js',
  'tests/preset-polish.test.js', 'tests/preset-proportions.test.js', 'tests/preset-seam.test.js',
]);
const EXCLUDED_NAMES = new Set(['.local-data', '.git', 'ArtReview', 'artifacts', '__pycache__', 'node_modules']);
const ACTIVE_CATALOG = 'assets/clean-gladiator/v013/manifest.json';
const LEGACY_CATALOG = 'assets/clean-gladiator/v006/manifest.json';
const POSIX = value => value.split(sep).join('/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, target) => {
  const path = relative(parent, target);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const excluded = path => path.split('/').some(name => EXCLUDED_NAMES.has(name)) || HISTORY_TESTS.has(path);

async function inventory(root) {
  const files = [];
  async function visit(path) {
    if (excluded(path)) return;
    const fullPath = resolve(root, path), info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`Release entries cannot contain symlinks: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(fullPath)).sort()) await visit(`${path}/${name}`);
    } else if (info.isFile()) files.push(path);
    else throw new Error(`Unsupported release entry: ${path}`);
  }
  for (const path of RELEASE_ENTRIES) await visit(path);
  return [...new Set(files)].sort();
}

async function snapshot(root, paths) {
  const records = [];
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path));
    records.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  return records;
}

async function checkDestinationParents(root, destination) {
  let parent = dirname(destination);
  while (parent !== root) {
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Release parent must be a real directory: ${parent}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    parent = dirname(parent);
  }
}

function referencedPath(value) {
  if (typeof value !== 'string' || !/^\/(assets|public)\//.test(value)) return null;
  if (!/^\/(assets|public)\/[a-zA-Z0-9/_.-]+\.(png|jpg|json|mp4)$/.test(value)
    || value.split('/').some(part => part === '..' || part === '.')) throw new Error(`Invalid local catalog reference: ${value}`);
  return value.slice(1);
}

async function validateCatalogs(root, records) {
  const indexed = new Map(records.map(record => [record.path, record]));
  const catalogs = [];
  for (const [path, mode] of [[ACTIVE_CATALOG, 'preset-faces-v1'], [LEGACY_CATALOG, 'fixed-skull-v1']]) {
    if (!indexed.has(path)) throw new Error(`Selected identity catalog is missing: ${path}`);
    const catalog = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    if (catalog.schema !== 'last-laurel.arena-identity.v1' || catalog.identityMode !== mode) throw new Error(`Selected identity catalog is invalid: ${path}`);
    if (mode === 'preset-faces-v1') {
      if (catalog.styleVersion !== 'arena-identity-v4') throw new Error('Current identity catalog must use preset faces.');
      const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
      for (const sex of ['male', 'female']) {
        const entries = catalog.facePresets?.[sex];
        if (!entries || Object.keys(entries).length !== 10 || ids.some(id => !entries[id])) throw new Error(`Current catalog needs ten ${sex} identities.`);
        for (const id of ids) if (entries[id].width !== 192 || entries[id].height !== 160 || !entries[id].url || !entries[id].materialsUrl) throw new Error(`Incomplete current identity: ${sex}/${id}`);
      }
    } else if (catalog.styleVersion !== 'arena-identity-v3') throw new Error('Legacy identity catalog must preserve fixed skulls.');
    const references = new Set();
    async function visit(value) {
      if (Array.isArray(value)) { for (const item of value) await visit(item); return; }
      if (value && typeof value === 'object') {
        for (const [key, expectedHash] of [['url', value.sha256], ['materialsUrl', value.materialsSha256]]) {
          const reference = referencedPath(value[key]);
          if (reference && expectedHash && indexed.get(reference)?.sha256 !== expectedHash) throw new Error(`Catalog hash disagrees with source: ${reference}`);
        }
        for (const [key, item] of Object.entries(value)) {
          const reference = referencedPath(item);
          if (reference) {
            references.add(reference);
            if (!indexed.has(reference)) throw new Error(`Catalog reference is missing from release: ${reference}`);
            if (['url', 'materialsUrl', 'handsUrl'].includes(key) && reference.endsWith('.png') && Number.isInteger(value.width) && Number.isInteger(value.height)) {
              const bytes = await readFile(resolve(root, reference));
              if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== value.width || bytes.readUInt32BE(20) !== value.height) throw new Error(`Catalog PNG dimensions disagree: ${reference}`);
            }
          }
          await visit(item);
        }
      }
    }
    await visit(catalog);
    catalogs.push({ path, identityMode: mode, sha256: indexed.get(path).sha256, references: [...references].sort() });
  }
  return catalogs;
}

function sameSnapshot(expected, actual) {
  return expected.length === actual.length && expected.every((entry, i) => entry.path === actual[i].path && entry.bytes === actual[i].bytes && entry.sha256 === actual[i].sha256);
}

export async function packageCurrent(config = {}) {
  const root = resolve(config.root ?? PROJECT_ROOT);
  const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const version = config.version ?? packageInfo.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be major.minor.patch.');
  const destination = resolve(root, config.destination ?? `releases/Arena_Fighters_v${version}_v001`);
  if (!inside(resolve(root, 'releases'), destination)) throw new Error('Release destination must be a new directory inside this project\'s releases folder.');
  await checkDestinationParents(root, destination);
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error(`Release destination already exists; choose a new versioned directory: ${destination}`);
  const provenance = config.provenance ?? [];
  if (!Array.isArray(provenance) || provenance.some(entry => !entry || typeof entry.chatId !== 'string' || !entry.chatId.trim() || (entry.note !== undefined && typeof entry.note !== 'string'))) throw new Error('Provenance must be an array of { chatId, note? } records.');
  if (packageInfo.version !== version) throw new Error(`Source package version ${packageInfo.version} does not match release ${version}.`);
  const paths = await inventory(root), records = await snapshot(root, paths);
  const catalogs = await validateCatalogs(root, records);
  await checkDestinationParents(root, destination);
  await mkdir(dirname(destination), { recursive: true });
  // Deliberately non-recursive: a concurrent creator must also be refused.
  await mkdir(destination);
  const markerPath = resolve(destination, 'BUILD_STATUS.json');
  await writeFile(markerPath, `${JSON.stringify({ status: 'incomplete', version, startedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  for (const record of records) {
    const bytes = await readFile(resolve(root, record.path));
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error(`Source changed during packaging: ${record.path}. Incomplete release retained at ${destination}`);
    const output = resolve(destination, record.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx' });
  }
  const copied = await snapshot(destination, paths);
  if (!sameSnapshot(records, copied)) throw new Error(`Copied bytes failed verification. Incomplete release retained at ${destination}`);
  await validateCatalogs(destination, copied);
  const finalSource = await snapshot(root, await inventory(root));
  if (!sameSnapshot(records, finalSource)) throw new Error(`Source changed during packaging. Incomplete release retained at ${destination}`);
  const manifest = {
    schema: 'arena-fighters.local-release.v1', status: 'complete', version,
    createdAt: new Date().toISOString(), directory: POSIX(relative(root, destination)),
    identity: { active: { version: 'v013', catalog: ACTIVE_CATALOG }, legacy: { version: 'v006', catalog: LEGACY_CATALOG } },
    provenance: provenance.map(({ chatId, note }) => ({ chatId, ...(note === undefined ? {} : { note }) })),
    entries: RELEASE_ENTRIES, exclusions: { directoryNames: [...EXCLUDED_NAMES].sort(), historyTests: [...HISTORY_TESTS].sort() },
    verification: { algorithm: 'SHA-256', sourceRecheckedAfterCopy: true, copiedBytesVerified: true, catalogReferencesVerified: true },
    fileCount: records.length, totalBytes: records.reduce((sum, entry) => sum + entry.bytes, 0), catalogs, files: records,
  };
  await writeFile(resolve(destination, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  // Keep the marker as an audit record rather than deleting a file.
  await writeFile(markerPath, `${JSON.stringify({ status: 'complete', version, manifest: 'BUILD_MANIFEST.json' }, null, 2)}\n`);
  return { destination, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: node tools/package-current.mjs [--config release-config.json]');
  const config = args.length ? JSON.parse(await readFile(resolve(PROJECT_ROOT, args[1]), 'utf8')) : {};
  if (Object.keys(config).some(key => !['version', 'destination', 'provenance'].includes(key))) throw new Error('Release config only supports version, destination and provenance.');
  const result = await packageCurrent(config);
  process.stdout.write(`${JSON.stringify({ destination: result.destination, version: result.manifest.version, files: result.manifest.fileCount, bytes: result.manifest.totalBytes, verified: true })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
