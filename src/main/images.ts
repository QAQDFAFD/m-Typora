import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { UploadConfig, UploadFile } from '../shared/api'

const COMMAND_TIMEOUT = 120_000

/** Pasted screenshots only exist in memory; uploaders need a file. */
async function preparePaths(files: UploadFile[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  let dirPromise: Promise<string> | null = null
  const ensureDir = () => (dirPromise ??= mkdtemp(join(tmpdir(), 'm-typora-upload-')))
  const paths = await Promise.all(
    files.map(async (file, index) => {
      if (file.path) return file.path
      const dir = await ensureDir()
      const target = join(dir, `${Date.now()}-${index}-${basename(file.name).replace(/[^\w.-]+/g, '_') || 'image.png'}`)
      await writeFile(target, Buffer.from(file.data ?? new ArrayBuffer(0)))
      return target
    })
  )
  const cleanup = async () => {
    if (!dirPromise) return
    const dir = await dirPromise.catch(() => null)
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return { paths, cleanup }
}

/** PicGo.app's built-in server (PicGo › 设置 › 设置 Server, port 36677 by default). */
async function uploadWithPicgoApp(paths: string[], port: number): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: paths }),
      signal: AbortSignal.timeout(COMMAND_TIMEOUT)
    })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') {
      throw new Error(`PicGo 上传超时（${COMMAND_TIMEOUT / 1000} 秒无响应），请在 PicGo 中检查上传状态或网络配置。`)
    }
    throw new Error(`无法连接 PicGo（端口 ${port}）。请确认 PicGo 正在运行，并在 PicGo 的「设置 › 设置 Server」中打开了 Server，端口与偏好设置中的一致。`)
  }
  const result = (await response.json().catch(() => ({}))) as { success?: boolean; result?: string[]; message?: string; msg?: string }
  if (!result.success || !Array.isArray(result.result) || result.result.length < paths.length) {
    throw new Error(`PicGo 上传失败${result.message || result.msg ? `：${result.message || result.msg}` : '，请在 PicGo 中查看日志。'}`)
  }
  return result.result
}

const quote = (value: string) =>
  process.platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Runs `command <path>...` through the user's shell (a login shell on macOS / Linux, so
 * tools installed with npm or Homebrew are on PATH) and reads one URL per image from the
 * last lines of its output — the same contract as Typora's custom upload command.
 */
function uploadWithCommand(command: string, paths: string[]): Promise<string[]> {
  const line = `${command} ${paths.map(quote).join(' ')}`
  const [shell, args] =
    process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`]]
      : [process.env.SHELL || '/bin/sh', ['-l', '-c', line]]
  return new Promise((resolve, reject) => {
    execFile(shell, args, { timeout: COMMAND_TIMEOUT, windowsVerbatimArguments: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const urls = String(stdout)
        .split(/\r?\n/)
        .map((text) => text.trim())
        .filter((text) => /^https?:\/\/\S+$/i.test(text))
      if (urls.length >= paths.length) return resolve(urls.slice(-paths.length))
      const output = `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-6).join('\n')
      reject(new Error(`上传命令没有返回图片地址${error ? `（${error.message.split('\n')[0]}）` : ''}${output ? `：\n${output}` : ''}`))
    })
  })
}

export async function uploadImages(files: UploadFile[], config: UploadConfig): Promise<string[]> {
  if (files.length === 0) return []
  const { paths, cleanup } = await preparePaths(files)
  try {
    switch (config.service) {
      case 'picgo-app':
        return await uploadWithPicgoApp(paths, config.picgoPort)
      case 'picgo-core':
        return await uploadWithCommand(`${quote(config.picgoPath.trim() || 'picgo')} upload`, paths)
      case 'custom':
        if (!config.command.trim()) throw new Error('还没有填写自定义上传命令。')
        return await uploadWithCommand(config.command.trim(), paths)
    }
  } finally {
    await cleanup()
  }
}
