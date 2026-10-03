/** Read local rules plus curated art without mutating either; outputs are private derived metadata. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { yrCameos, YR_UI } from '../games/yrUi.ts';
import { GameInstall } from '../node/install.ts';
import { writeCameos } from '../node/ui.ts';

const { values } = parseArgs({
  options: {
    game: { type: 'string' },
    cache: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.game || !values.cache || !values.out)
  throw new Error('usage: auditCameos --game INSTALL --cache CAMEOS_DIR --out OUT');
const cache = resolve(values.cache),
  out = resolve(values.out);
if (out === cache || out.startsWith(cache + '/')) throw new Error('Audit output must not mutate the source cache');
mkdirSync(out, { recursive: true });
const install = GameInstall.open(resolve(values.game), 'temperate');
const indexPath = join(cache, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  images: Record<string, { hd?: string; orig?: string; caption?: string }>;
  byId: Record<string, string>;
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reports = [];
for (const [variant, policy] of [
  ['ra2', { ...YR_UI, rules: 'rules.ini', art: 'art.ini', strings: 'ra2.csf' }],
  ['yr', YR_UI],
] as const) {
  const source = yrCameos(install, policy);
  const entries = writeCameos({ out: join(out, variant), ...source, size: YR_UI.cameoSize });
  const images = new Map<
    string,
    {
      name: string;
      roles: string[];
      types: string[];
      buildableTypes: string[];
      native: boolean;
      hd: boolean;
      indexedOriginal: boolean;
      caption: string | null;
    }
  >();
  for (const entry of entries) {
    for (const [role, name] of [
      ['primary', entry.cameo],
      ...(entry.alt ? [['alternate', entry.alt.toLowerCase()]] : []),
    ]) {
      const art = index.images[name!];
      const image = images.get(name!) ?? {
        name: name!,
        roles: [],
        types: [],
        buildableTypes: [],
        native: !!source.source.shape(name!),
        hd: !!art?.hd && existsSync(join(cache, art.hd)),
        indexedOriginal: !!art?.orig && existsSync(join(cache, art.orig)),
        caption: art?.caption ?? null,
      };
      if (!image.roles.includes(role!)) image.roles.push(role!);
      if (!image.types.includes(entry.id)) image.types.push(entry.id);
      if (entry.buildable && !image.buildableTypes.includes(entry.id)) image.buildableTypes.push(entry.id);
      images.set(name!, image);
    }
  }
  const all = [...images.values()].sort((a, b) => a.name.localeCompare(b.name));
  reports.push({
    variant,
    files: Object.fromEntries(
      [policy.rules, policy.art, policy.strings].map((file) => [file, hash(install.read(file)!)]),
    ),
    entries: entries.length,
    buildableEntries: entries.filter((e) => e.buildable).length,
    distinctImages: all.length,
    hdImages: all.filter((image) => image.hd).length,
    missingHd: all.filter((image) => !image.hd),
    missingOriginals: all.filter((image) => !image.native),
    unmappedTypes: entries.filter((e) => !index.byId[e.id]).map((e) => e.id),
    images: all,
  });
}
const report = {
  sourceIndexSha256: hash(readFileSync(indexPath)),
  scope:
    'All RA2 and YR registered primary/alternate cameos, including non-buildable tech/civil/campaign types. Shared XXICON remains a shared native placeholder; no invented type art. Map/mod overrides are not exhaustively covered.',
  reports,
};
writeFileSync(join(out, 'coverage.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    reports.map(({ variant, entries, buildableEntries, distinctImages, hdImages, missingHd, missingOriginals }) => ({
      variant,
      entries,
      buildableEntries,
      distinctImages,
      hdImages,
      missingHd: missingHd.length,
      missingOriginals: missingOriginals.length,
    })),
  ),
);
