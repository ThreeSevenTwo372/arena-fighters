import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { packageCurrent, RELEASE_ENTRIES } from '../tools/package-current.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'arena-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of RELEASE_ENTRIES) {
    if (!path.includes('.')) await mkdir(resolve(root, path), { recursive: true });
    else {
      await mkdir(resolve(root, path, '..'), { recursive: true });
      await writeFile(resolve(root, path), `${path}\n`);
    }
  }
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.8.0' }));
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12); png.writeUInt32BE(192, 16); png.writeUInt32BE(160, 20);
  const sha256 = createHash('sha256').update(png).digest('hex');
  const url = '/assets/clean-gladiator/v013/faces/source.png';
  await mkdir(resolve(root, 'assets/clean-gladiator/v013/faces'), { recursive: true });
  await writeFile(resolve(root, `.${url}`), png);
  const facePresets = Object.fromEntries(['male', 'female'].map(sex => [sex, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `p${String(i + 1).padStart(2, '0')}`, { width: 192, height: 160, url, materialsUrl: url, sha256, materialsSha256: sha256 },
  ]))]));
  const active = { schema: 'last-laurel.arena-identity.v1', identityMode: 'preset-faces-v1', styleVersion: 'arena-identity-v4', facePresets };
  await writeFile(resolve(root, 'assets/clean-gladiator/v013/manifest.json'), JSON.stringify(active));
  await mkdir(resolve(root, 'assets/clean-gladiator/v006'), { recursive: true });
  await writeFile(resolve(root, 'assets/clean-gladiator/v006/manifest.json'), JSON.stringify({ schema: active.schema, identityMode: 'fixed-skull-v1', styleVersion: 'arena-identity-v3', source: { url, width: 192, height: 160 } }));
  await mkdir(resolve(root, '.local-data'), { recursive: true });
  await writeFile(resolve(root, '.local-data/online-duels.json'), 'private saved identity');
  await mkdir(resolve(root, 'assets/.git'), { recursive: true });
  await writeFile(resolve(root, 'assets/.git/private'), 'private');
  await writeFile(resolve(root, 'tests/armory.test.js'), 'requires source history');
  await writeFile(resolve(root, 'tests/runtime.test.js'), 'portable runtime test');
  return { root, png, url };
}

test('portable release verifies copied bytes, retains both identity catalogs and excludes private/history data', async t => {
  const source = await fixture(t);
  const { destination, manifest } = await packageCurrent({ root: source.root, provenance: [{ chatId: 'prior-chat', note: 'Tournament update' }] });
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.identity.active.version, 'v013');
  assert.equal(manifest.identity.legacy.version, 'v006');
  assert.deepEqual(manifest.provenance, [{ chatId: 'prior-chat', note: 'Tournament update' }]);
  assert.deepEqual(await readFile(resolve(destination, `.${source.url}`)), source.png);
  for (const file of manifest.files) {
    const bytes = await readFile(resolve(destination, file.path));
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.ok(manifest.files.some(entry => entry.path === 'tests/runtime.test.js'));
  for (const path of ['.local-data/online-duels.json', 'assets/.git/private', 'tests/armory.test.js']) await assert.rejects(access(resolve(destination, path)), { code: 'ENOENT' });
  await assert.rejects(packageCurrent({ root: source.root }), /already exists/);
  assert.deepEqual(await readFile(resolve(destination, `.${source.url}`)), source.png);
});

test('missing or modified catalog sources fail before creating a release', async t => {
  const source = await fixture(t);
  await writeFile(resolve(source.root, `.${source.url}`), Buffer.from('changed original artwork'));
  await assert.rejects(packageCurrent({ root: source.root }), /Catalog hash disagrees/);
  await assert.rejects(access(resolve(source.root, 'releases/Arena_Fighters_v0.8.0_v001')), { code: 'ENOENT' });
  await rm(resolve(source.root, `.${source.url}`));
  await assert.rejects(packageCurrent({ root: source.root }), /Catalog hash disagrees|reference is missing/);
});

test('release version and destination must be deliberate and protected', async t => {
  const source = await fixture(t);
  await assert.rejects(packageCurrent({ root: source.root, version: '0.7.0' }), /does not match release/);
  await assert.rejects(packageCurrent({ root: source.root, destination: '../existing-user-folder' }), /inside this project's releases/);
  await assert.rejects(packageCurrent({ root: source.root, provenance: ['unknown chat'] }), /Provenance must/);
});

test('source additions during copying retain an incomplete release instead of certifying mixed work', async t => {
  const source = await fixture(t);
  let changed = false;
  const watcher = watch(source.root, (event, filename) => {
    if (!changed && filename?.toString() === 'releases') {
      changed = true;
      writeFileSync(resolve(source.root, 'src/late-agent-change.js'), 'new work during copying');
    }
  });
  t.after(() => watcher.close());
  await assert.rejects(packageCurrent({ root: source.root }), /Source changed during packaging/);
  assert.equal(changed, true);
  const destination = resolve(source.root, 'releases/Arena_Fighters_v0.8.0_v001');
  assert.equal(JSON.parse(await readFile(resolve(destination, 'BUILD_STATUS.json'), 'utf8')).status, 'incomplete');
  await assert.rejects(access(resolve(destination, 'BUILD_MANIFEST.json')), { code: 'ENOENT' });
});
