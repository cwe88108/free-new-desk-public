import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {executableEnvironment} from './trusted-worker.js';

const run = promisify(execFile);
const versionProbe = 'import sys; print(sys.implementation.name, *sys.version_info[:3])';
const setupHint = '请安装 CPython 3.10 或更高版本，并将 FND_PYTHON_COMMAND 设为解释器路径。';

async function resolvePythonCommand(): Promise<string> {
  const configured = process.env.FND_PYTHON_COMMAND?.trim();
  if (process.platform !== 'win32') return configured || 'python3';
  const command = configured || 'python.exe';
  if (!path.isAbsolute(command) && path.basename(command) !== command) {
    throw new Error(`[SRC_PYTHON_NOT_FOUND] 请使用绝对路径或 PATH 中的解释器名称。${setupHint}`);
  }
  const executable = path.extname(command) ? command : command + '.exe';
  const directories = (process.env.PATH ?? '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ''));
  const candidates = path.isAbsolute(executable) ? [executable] : directories.filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, executable));
  for (const candidate of candidates) {
    // Windows Store aliases can open an installer instead of starting Python.
    if (/[\\/]Microsoft[\\/]WindowsApps[\\/][^\\/]+\.exe$/i.test(candidate)) continue;
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error(`[SRC_PYTHON_NOT_FOUND] 未找到可运行的 Python 解释器。${setupHint}`);
}

export async function probePythonRuntime(signal?: AbortSignal): Promise<{command:string; version:string}> {
  signal?.throwIfAborted();
  const command = await resolvePythonCommand();
  let stdout: string;
  try {
    ({stdout} = await run(command, ['-I', '-S', '-X', 'utf8', '-c', versionProbe], {
      cwd: os.tmpdir(), env: executableEnvironment(), windowsHide: true,
      timeout: 5_000, maxBuffer: 8 * 1024, encoding: 'utf8', ...(signal ? {signal} : {}),
    }));
  } catch {
    signal?.throwIfAborted();
    throw new Error(`[SRC_PYTHON_NOT_FOUND] Python 解释器未能完成启动检查。${setupHint}`);
  }
  const version = /^cpython (\d+) (\d+) (\d+)$/.exec(stdout.trim());
  if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 10)) {
    throw new Error(`[SRC_PYTHON_UNAVAILABLE] 当前解释器不是受支持的 CPython。${setupHint}`);
  }
  return {command, version:version.slice(1).join('.')};
}
