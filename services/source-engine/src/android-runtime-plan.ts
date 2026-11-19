import { inspectJar, jarClassPath, type JarInspection } from './jar-inspector.js';

/** Static requirements only: this is not a compatibility or execution attestation. */
export interface AndroidRuntimePlan {
  level: 'A0' | 'A2' | 'A3' | 'A4';
  runtime: 'jvm' | 'android';
  requirements: Array<'art-dex' | 'framework' | 'webview' | 'dynamic-dex' | 'native'>;
  abis: string[];
}

export function planAndroidRuntime(inspection: JarInspection): AndroidRuntimePlan {
  const requirements: AndroidRuntimePlan['requirements'] = [];
  if (inspection.dexEntries > 0) requirements.push('art-dex');
  if (inspection.androidRefs.length > 0 || inspection.hasManifest) requirements.push('framework');
  if (inspection.highRisk.includes('WebView')) requirements.push('webview');
  if (inspection.highRisk.includes('DexClassLoader')) requirements.push('dynamic-dex');
  if (inspection.kind === 'NATIVE') requirements.push('native');
  const level = requirements.includes('native') ? 'A4'
    : requirements.includes('webview') || requirements.includes('dynamic-dex') ? 'A3'
      : requirements.length > 0 ? 'A2' : 'A0';
  return { level, runtime: level === 'A0' ? 'jvm' : 'android', requirements, abis: [...inspection.abis] };
}

/** Runs after bundle authorization, before staging files or starting a JVM.
 * Resource-only dependency JARs are permitted; no unimplemented framework shim is assumed.
 */
export function assertJvmRuntimeBundle(artifacts: ReadonlyArray<{
  role: string; content: string;
}>, className: string): void {
  const entry = artifacts.find(artifact => artifact.role === 'entry');
  if (!entry) throw new Error('[SRC_JAR_INVALID] JAR entry not found');
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.content, 'base64');
    // Reuse the bounded central-directory validator; malformed archives fail closed.
    try { jarClassPath(bytes); } catch {
      throw new Error('[SRC_JAR_INVALID] JAR directory cannot be safely inspected');
    }
    const inspection = inspectJar(bytes, artifact === entry ? className : undefined);
    const resourceOnly = artifact !== entry && inspection.entries > 0
      && inspection.classEntries === 0 && inspection.dexEntries === 0
      && inspection.kind === 'INVALID';
    if (inspection.kind === 'INVALID' && !resourceOnly) {
      throw new Error('[SRC_JAR_INVALID] JAR executable content cannot be safely inspected');
    }
    const plan = planAndroidRuntime(inspection);
    if (plan.runtime === 'android') {
      const code = inspection.kind === 'DEX' ? 'SRC_JAR_DEX_UNSUPPORTED' : 'SRC_JAR_NEEDS_ANDROID';
      // Never include source paths, credentials or untrusted scan strings in diagnostics.
      throw new Error(`[${code}] unsupported-runtime: android (${plan.level}; ${plan.requirements.join(', ')}). 需要真实 Android runtime；当前未配置经验证的 Android companion。`);
    }
    if (artifact === entry && !inspection.declaredClassFound) {
      throw new Error('[SRC_JAR_CLASS_MISSING] 配置引用的 Spider 类不在包中');
    }
  }
}
