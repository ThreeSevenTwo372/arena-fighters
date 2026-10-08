import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const baseline = path.join(root, 'releases/Arena_Fighters_v0.9.0_v001');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
async function compareDirectory(relative) {
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const target = path.join(relative, item.name);
    if (item.isDirectory()) await compareDirectory(target);
    else {
      const [current, preserved] = await Promise.all([fs.readFile(path.join(root, target)), fs.readFile(path.join(baseline, target))]);
      if (!current.equals(preserved)) throw new Error(`Preserved asset changed: ${target}`);
      files.push({ path: target.replaceAll('\\', '/'), sha256: hash(current), bytes: current.length });
    }
  }
}
for (const version of ['v003', 'v006', 'v013']) await compareDirectory(`assets/clean-gladiator/${version}`);
const catalogs = await Promise.all(['v006', 'v013'].map(async version => {
  const catalog = JSON.parse(await fs.readFile(path.join(root, `assets/clean-gladiator/${version}/manifest.json`), 'utf8'));
  return { version, identityMode: catalog.identityMode, identityTransform: catalog.identityTransform,
    identityOffsetBySex: catalog.identityOffsetBySex ?? null, helmetTransformBySex: catalog.helmetTransformBySex ?? null,
    bodyRegistrations: Object.fromEntries(Object.entries(catalog.bodies).map(([sex, armors]) => [sex, Object.fromEntries(Object.entries(armors).map(([armor, body]) => [armor, { mainhandGrip: body.mainhandGrip, offhandGrip: body.offhandGrip, url: body.url, handsUrl: body.handsUrl }]))])) };
}));
const receipt = { schema: 'arena-equipment-registration-v1', weapon: 'dagger', package: '/assets/clean-gladiator/v014-equipment/manifest.json',
  texture: '/assets/clean-gladiator/v014-equipment/weapons/dagger.png', canvas: [16, 36], grip: [7, 29], sourceFacing: 'W',
  runtimePlacement: 'Existing body.mainhandGrip; existing outward stow angle and mirror; no body, hand, head, or armor offsets.',
  preservedBaseline: 'releases/Arena_Fighters_v0.9.0_v001', comparedFiles: files.length, preservedFiles: files, catalogs,
  review: { firstPair: 'artifacts/Weapon_Dagger_v001/dagger-actual-renderer-first-pair.png', allArmors: 'artifacts/Weapon_Dagger_v001/dagger-actual-renderer-all-armors.png',
    evidence: 'Source assets byte-identical to the independent prior release. Whole-figure renderer rasters inspected at native and 2x sizes. Browser facing/attack checks and user art acceptance remain distinct.' } };
await fs.writeFile(new URL('REGISTRATION_RECEIPT.json', import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ preservedFiles: files.length, unchanged: true, grip: receipt.grip, canvas: receipt.canvas }));
