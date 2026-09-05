import test from 'node:test';
import assert from 'node:assert/strict';
import { probeJavaRuntime } from '../../services/source-engine/dist/java-runtime.js';

test('missing Java runtime produces stable SRC_JAVA_NOT_FOUND error',async()=>{
  await assert.rejects(()=>probeJavaRuntime('free-new-desk-java-that-does-not-exist',500),/SRC_JAVA_NOT_FOUND/);
});
