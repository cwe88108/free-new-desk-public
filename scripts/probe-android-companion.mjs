import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { AndroidCompanionFixtureClient } from '../services/source-engine/dist/android-companion-fixture.js';

// Pairing JSON is an explicitly supplied, local temporary secret file. Never print it.
// This script neither installs an APK nor enables/forwards adb, and never loads source code.
const [pairingFile, outputFile] = process.argv.slice(2);
if (!pairingFile || !outputFile) {
  console.error('Usage: node scripts/probe-android-companion.mjs <temporary-pairing.json> <result.json>');
  process.exitCode = 2;
} else {
  const evidence = { schema: 1, timestamp: new Date().toISOString(), profile: 'builtin-tone-v1',
    scope: 'Android companion built-in fixture only; NOT third-party source or Windows playback compatibility', stages: [] };
  let client;
  try {
    const pairing = JSON.parse(await readFile(pairingFile, 'utf8'));
    client = new AndroidCompanionFixtureClient(pairing);
    const capabilities = await client.capabilities();
    if (capabilities.protocol !== 1 || capabilities.profile !== 'builtin-tone-v1' || capabilities.externalCode !== false
      || !Number.isInteger(capabilities.apiLevel) || !Array.isArray(capabilities.abis)
      || !capabilities.abis.every(abi => typeof abi === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(abi))) throw new Error('ANDROID_CAPABILITIES_INVALID');
    evidence.device = { apiLevel: capabilities.apiLevel, abis: capabilities.abis };
    evidence.stages.push('pinned-tls-capabilities');
    await client.init(); evidence.stages.push('init');
    for (const method of ['home', 'category', 'search', 'detail']) { await client.call(method); evidence.stages.push(method); }
    const play = await client.call('play');
    if (typeof play.resourceHandle !== 'string' || typeof play.sha256 !== 'string') throw new Error('ANDROID_PLAY_INVALID');
    const media = await client.media(play.resourceHandle);
    if (media.status !== 200 || media.headers['content-type'] !== 'audio/wav'
      || media.body.length !== play.length || createHash('sha256').update(media.body).digest('hex') !== play.sha256
      || media.body.toString('ascii', 0, 4) !== 'RIFF' || media.body.toString('ascii', 8, 12) !== 'WAVE') throw new Error('ANDROID_MEDIA_INVALID');
    evidence.stages.push('play-and-full-media-digest');
    const range = await client.media(play.resourceHandle, { start: 44, end: 107 });
    if (range.status !== 206 || range.headers['content-range'] !== `bytes 44-107/${media.body.length}`
      || !range.body.equals(media.body.subarray(44, 108))) throw new Error('ANDROID_RANGE_INVALID');
    evidence.stages.push('media-range');
    await client.destroy(); evidence.stages.push('destroy');
    evidence.status = 'fixture-passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error && /^ANDROID_[A-Z_]+$/.test(error.message) ? error.message : 'ANDROID_PROBE_FAILED';
    process.exitCode = 1;
  } finally { client?.close(); }
  // Fail rather than silently replace an earlier evidence artifact.
  await writeFile(outputFile, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Companion fixture probe: ${evidence.status}. No third-party source/Windows playback claim.`);
}
