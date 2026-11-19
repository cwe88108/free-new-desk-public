import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceConfigSchema, LiveSourceConfigSchema, SourceCategoryRequestSchema, PlayRequestSchema, SourceDetailRequestSchema, PlayerCommandSchema, MusicPlayRequestSchema } from '../../packages/contracts/dist/index.js';
import { VodFavoritesSchema, FavoritesImportSchema, VodFavoriteMutationSchema } from '../../packages/contracts/dist/favorites.js';

test('Zod 4 keeps source, live, filter and playback string dictionaries', () => {
  const headers = { Referer: 'https://example.com/', 'User-Agent': 'player' };
  const source = { id: 'source', name: 'Source', kind: 'T1_JSON', endpoint: 'https://example.com/', enabled: true, trust: 'A', headers };
  assert.deepEqual(SourceConfigSchema.parse(source), source);
  assert.deepEqual(LiveSourceConfigSchema.parse({ ...source }).headers, headers);
  assert.deepEqual(SourceCategoryRequestSchema.parse({ sourceId: 'source', categoryId: 'movies', filters: { year: '2026' } }).filters, { year: '2026' });
  assert.deepEqual(PlayRequestSchema.parse({ url: 'https://example.com/movie', headers }).headers, headers);
  for (const schema of [SourceConfigSchema, LiveSourceConfigSchema]) assert.equal(schema.safeParse({ ...source, headers: { Bad: 1 } }).success, false);
  assert.equal(SourceCategoryRequestSchema.safeParse({ sourceId: 'source', categoryId: 'movies', filters: { year: 2026 } }).success, false);
  assert.equal(PlayRequestSchema.safeParse({ url: 'x', headers: { Bad: 1 } }).success, false);
});

test('Zod 4 preserves IPC unions, bounds, optional fields and playback refinements', () => {
  assert.deepEqual(PlayerCommandSchema.parse({ command: 'seek', value: 12, requestId: 'r', loadId: 'l' }), { command: 'seek', value: 12, requestId: 'r', loadId: 'l' });
  assert.deepEqual(MusicPlayRequestSchema.parse({ trackId: 't' }), { trackId: 't' });
  assert.equal(PlayerCommandSchema.safeParse({ command: 'volume', value: 101 }).success, false);
  assert.equal(PlayRequestSchema.safeParse({ url: 'x', startSeconds: 20, endSeconds: 10 }).success, false);
  assert.equal(SourceDetailRequestSchema.safeParse({ sourceId: 's', ids: Array(21).fill('id') }).success, false);
});

test('Zod 4 preserves favorites date normalization, discriminated mutations and import limits', () => {
  const favorite = { sourceId: 's', videoId: 'v', sourceName: 'Source', name: 'Video', createdAt: '2026-11-03T08:00:00+08:00' };
  const parsed = VodFavoritesSchema.parse([favorite]);
  assert.equal(parsed[0].createdAt, '2026-11-03T00:00:00.000Z');
  assert.equal(VodFavoriteMutationSchema.parse({ kind: 'rename', sourceId: 's', videoId: 'v', label: '  New  ' }).label, 'New');
  assert.equal(FavoritesImportSchema.safeParse({}).success, false);
  assert.equal(FavoritesImportSchema.safeParse({ vod: Array(5001).fill(favorite) }).success, false);
  assert.equal(VodFavoritesSchema.safeParse([{ ...favorite, sourceId: '\u0000' }]).success, false);
});
