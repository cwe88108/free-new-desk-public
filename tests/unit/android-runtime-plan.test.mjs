import test from 'node:test';
import assert from 'node:assert/strict';
import { assertJvmRuntimeBundle, planAndroidRuntime } from '../../services/source-engine/dist/android-runtime-plan.js';
import { inspectJar } from '../../services/source-engine/dist/jar-inspector.js';
function zip(entries){let offset=0;const locals=[],central=[];for(const [name,text] of entries){const n=Buffer.from(name),data=Buffer.from(text),head=Buffer.alloc(30),record=Buffer.alloc(46);head.writeUInt32LE(0x04034b50);head.writeUInt32LE(data.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(n.length,26);record.writeUInt32LE(0x02014b50);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(n.length,28);record.writeUInt32LE(offset,42);const local=Buffer.concat([head,n,data]);locals.push(local);central.push(record,n);offset+=local.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);}
const className = 'com.example.Spider';
const jar = (text = 'java/lang/Object') => zip([['com/example/Spider.class', text]]);
const artifact = (bytes, role = 'entry') => ({ role, content: bytes.toString('base64') });
// Deliberately inert ZIP bytes: tests inspect metadata, never load or execute code.
test('pure JVM entry and resource-only dependency retain the JVM route', () => {
  const bytes = jar();
  assert.deepEqual(planAndroidRuntime(inspectJar(bytes)), { level: 'A0', runtime: 'jvm', requirements: [], abis: [] });
  assert.doesNotThrow(() => assertJvmRuntimeBundle([artifact(bytes), artifact(zip([['data.txt', 'ok']]), 'dependency')], className));
});
test('Context and even simple Android APIs are not silently promised as JVM shims', () => {
  for (const ref of ['android/content/Context', 'android/util/Base64', 'android.os.Handler']) {
    const bytes = jar(ref);
    assert.equal(planAndroidRuntime(inspectJar(bytes)).level, 'A2');
    assert.throws(() => assertJvmRuntimeBundle([artifact(bytes)], className), /SRC_JAR_NEEDS_ANDROID.*unsupported-runtime: android/);
  }
});
test('pure and hybrid DEX require a real Android runtime', () => {
  const dex = ['classes.dex', 'dex\n035\0Lcom/example/Spider;'];
  assert.throws(() => assertJvmRuntimeBundle([artifact(zip([dex]))], className), /SRC_JAR_DEX_UNSUPPORTED/);
  assert.throws(() => assertJvmRuntimeBundle([artifact(zip([['com/example/Spider.class', 'java/lang/Object'], dex]))], className), /SRC_JAR_NEEDS_ANDROID.*art-dex/);
});
test('WebView, dynamic DEX and native requirements are classified independently', () => {
  for (const [ref, level, capability] of [
    ['android/webkit/WebView', 'A3', 'webview'],
    ['dalvik/system/DexClassLoader', 'A3', 'dynamic-dex'],
    ['System/loadLibrary', 'A4', 'native'],
  ]) {
    const plan = planAndroidRuntime(inspectJar(jar(ref)));
    assert.equal(plan.level, level);
    assert.ok(plan.requirements.includes(capability));
  }
});
test('framework dependencies are rejected before any JVM launch, even for pure JVM entries', () => {
  assert.throws(() => assertJvmRuntimeBundle([artifact(jar()), artifact(jar('android/content/Context'), 'dependency')], className), /SRC_JAR_NEEDS_ANDROID/);
});
test('malformed archives and missing classes fail closed without echoing artifact content', () => {
  assert.throws(() => assertJvmRuntimeBundle([], className), /SRC_JAR_INVALID/);
  assert.throws(() => assertJvmRuntimeBundle([artifact(jar().subarray(0, -22))], className), /SRC_JAR_INVALID/);
  assert.throws(() => assertJvmRuntimeBundle([artifact(jar())], 'com.example.Missing'), /SRC_JAR_CLASS_MISSING/);
  assert.throws(() => assertJvmRuntimeBundle([artifact(jar('android/content/Context https://user:secret@example.com'))], className), error => !error.message.includes('secret') && !error.message.includes('example.com'));
});
test('Android manifests and native-only libraries in dependencies cannot pass as resources', () => {
  for (const entries of [[['AndroidManifest.xml', 'manifest']], [['lib/arm64-v8a/a.so', 'ELF']]]) {
    assert.throws(() => assertJvmRuntimeBundle([artifact(jar()), artifact(zip(entries), 'dependency')], className), /SRC_JAR_NEEDS_ANDROID/);
  }
});
