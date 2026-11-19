import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Tests pure Java safety helpers only, not Android SDK/ART/KeyStore or APK code.
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'native/android-companion/app/src/main/java/org/freenewdesk/companion');
const tests = path.join(root, 'native/android-companion/tests/CompanionSafetyTest.java');
const output = await mkdtemp(path.join(tmpdir(), 'fnd-companion-java-'));
const binary = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;
function run(name, args) {
  const result = spawnSync(binary(name), args, { stdio: 'inherit', timeout: 30_000 });
  if (result.error) throw new Error(`Companion helper ${name} could not start: ${result.error.code ?? 'unknown error'}; a configured JDK 17+ is required.`);
  if (result.status !== 0) throw new Error(`Companion helper ${name} exited with ${result.status}; see the test failure above.`);
}
try {
  run('javac', ['-encoding', 'UTF-8', '--release', '17', '-d', output, ...['JsonLimits', 'ResourceLease', 'SerialLifecycle'].map(name => path.join(source, `${name}.java`)), tests]);
  run('java', ['-cp', output, 'org.freenewdesk.companion.CompanionSafetyTest']);
} finally {
  const cleanup=path.resolve(output),tempRoot=path.resolve(tmpdir())+path.sep;
  if(!cleanup.startsWith(tempRoot)||!path.basename(cleanup).startsWith('fnd-companion-java-'))throw new Error('Refusing helper cleanup outside its temporary directory');
  await rm(cleanup, { recursive: true, force: true });
}
