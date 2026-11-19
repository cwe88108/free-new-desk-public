import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Offline dependency-free fixture build using official SDK tools, not a Gradle/network bypass.
// Requires an installed SDK whose license the operator has already accepted.
if (!process.env.JAVA_HOME || !process.env.ANDROID_HOME) throw new Error('Set JAVA_HOME (JDK 17) and ANDROID_HOME (SDK platform/build-tools 35).');
const root = path.resolve(import.meta.dirname, '..');
const project = path.join(root, 'native/android-companion');
const sdk = process.env.ANDROID_HOME;
const tools = path.join(sdk, 'build-tools/35.0.0');
const androidJar = path.join(sdk, 'platforms/android-35/android.jar');
const executable = name => name + (process.platform === 'win32' ? '.exe' : '');
const java = name => path.join(process.env.JAVA_HOME, 'bin', executable(name));
const sdkTool = name => path.join(tools, executable(name));
const output = path.join(project, 'app/build/outputs/apk/fixture/companion-fixture.apk');
const work = await mkdtemp(path.join(tmpdir(), 'fnd-companion-build-'));
const env = { ...process.env, FND_TEMP_SIGNING_PASSWORD: randomBytes(32).toString('hex') };
function run(command, args) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Offline fixture build failed at ${path.basename(command)}`);
}
async function files(directory, suffix) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename, suffix));
    else if (filename.endsWith(suffix)) result.push(filename);
  }
  return result.sort();
}
try {
  const classes = path.join(work, 'classes'), dex = path.join(work, 'dex');
  await mkdir(classes); await mkdir(dex); await mkdir(path.dirname(output), { recursive: true });
  const sources = await files(path.join(project, 'app/src/main/java'), '.java');
  run(java('javac'), ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-cp', androidJar, '-d', classes, ...sources]);
  run(java('java'), ['-cp', path.join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '26', '--lib', androidJar, '--output', dex, ...await files(classes, '.class')]);
  const manifest = (await readFile(path.join(project, 'app/src/main/AndroidManifest.xml'), 'utf8'))
    .replace('<manifest ', '<manifest package="org.freenewdesk.companion" ');
  const manifestFile = path.join(work, 'AndroidManifest.xml'); await writeFile(manifestFile, manifest);
  const unsigned = path.join(work, 'unsigned.apk'), aligned = path.join(work, 'aligned.apk');
  run(sdkTool('aapt2'), ['link', '-o', unsigned, '-I', androidJar, '--manifest', manifestFile,
    '--min-sdk-version', '26', '--target-sdk-version', '35', '--version-code', '1', '--version-name', '0.1.0-fixture', '--debug-mode']);
  run(java('jar'), ['--update', '--file', unsigned, '--no-manifest', '-C', dex, 'classes.dex']);
  run(sdkTool('zipalign'), ['-P', '16', '-f', '4', unsigned, aligned]);
  const keyStore = path.join(work, 'ephemeral-fixture.p12');
  run(java('keytool'), ['-genkeypair', '-keystore', keyStore, '-storetype', 'PKCS12', '-alias', 'fixture',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=FND Temporary Fixture',
    '-storepass:env', 'FND_TEMP_SIGNING_PASSWORD', '-keypass:env', 'FND_TEMP_SIGNING_PASSWORD']);
  run(java('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'sign', '--ks', keyStore, '--ks-key-alias', 'fixture',
    '--ks-pass', 'env:FND_TEMP_SIGNING_PASSWORD', '--out', output, aligned]);
  run(java('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', output]);
  run(sdkTool('aapt2'), ['dump', 'badging', output]);
  const apk = await readFile(output);
  const evidence = { profile: 'builtin-tone-v1', build: 'offline-official-sdk-tools', api: 35, minApi: 26, buildTools: '35.0.0',
    sha256: createHash('sha256').update(apk).digest('hex'), bytes: apk.length, signing: 'ephemeral fixture key, removed after build; not release signing',
    deviceExecution: 'not-run', thirdPartySources: 'unsupported' };
  await writeFile(`${output}.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Built fixture APK: ${output}\nSHA-256: ${evidence.sha256}\nNo device/ART/playback verification claimed.`);
} finally {
  delete env.FND_TEMP_SIGNING_PASSWORD;
  const cleanup=path.resolve(work),tempRoot=path.resolve(tmpdir())+path.sep;
  if(!cleanup.startsWith(tempRoot)||!path.basename(cleanup).startsWith('fnd-companion-build-'))throw new Error('Refusing fixture cleanup outside its temporary directory');
  await rm(cleanup, { recursive: true, force: true });
}
