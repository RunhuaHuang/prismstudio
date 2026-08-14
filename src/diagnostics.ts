import { appendFileSync, chmodSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { collectConfigSecrets, getConfigDir, getConfigPath, redactSensitiveText, type DuoConfig } from './config.js'
import type { MediaModality, MediaProtocol } from './engine/media-generation-engine.js'

const MAX_DIAGNOSTIC_LOG_BYTES = 5 * 1024 * 1024

export interface GenerationDiagnosticEvent {
  requestId: string
  source: 'mcp' | 'webui'
  outcome: 'success' | 'error'
  modality: MediaModality
  protocol?: MediaProtocol
  vendor?: string
  model?: string
  elapsedMs: number
  outputCount?: number
  error?: string
}

export function getDiagnosticsPath(config: DuoConfig): string {
  return config.diagnostics?.logFile?.trim()
    ? resolve(config.diagnostics.logFile.trim())
    : join(getConfigDir(), 'diagnostics.jsonl')
}

export function sanitizeDiagnosticError(error: string, config: DuoConfig, extraSecrets: Iterable<string> = []): string {
  const secrets = new Set(collectConfigSecrets(config))
  for (const value of extraSecrets) {
    if (typeof value === 'string' && value.trim().length >= 4) secrets.add(value.trim())
  }
  return redactSensitiveText(error, secrets)
    // Provider errors occasionally echo structured request fields instead of the
    // plain prompt. Remove the value before path/URL cleanup and truncation.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,\s]+)*,[a-z0-9+/=_-]+/gi, 'data:[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl)
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[REDACTED_URL]'
      }
    })
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '[LOCAL_PATH]')
    .replace(/(^|[\s("'=])\/(?:Users|home|private|var|tmp|etc|opt|Volumes)\/[^\s"'<>),;]*/g, '$1[LOCAL_PATH]')
    .slice(0, 500)
}

/**
 * 记录最小化、脱敏的 JSONL 事件。永不记录 prompt、API Key、参考路径或输出路径；
 * 写入失败只告警，不影响生成主流程。日志超过 5 MiB 时保留一份滚动备份。
 */
function comparablePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isSameExistingFile(left: string, right: string): boolean {
  try {
    const a = statSync(left)
    const b = statSync(right)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

export function writeGenerationDiagnostic(
  config: DuoConfig,
  event: GenerationDiagnosticEvent,
  extraSecrets: Iterable<string> = [],
): void {
  if (!config.diagnostics?.enabled) return
  const path = getDiagnosticsPath(config)
  try {
    // Never append JSONL to config.json. Compare both normalized and real paths
    // so a symlink to the config file cannot corrupt the configuration.
    if (comparablePath(path) === comparablePath(getConfigPath()) || isSameExistingFile(path, getConfigPath())) {
      process.stderr.write(`[prismstudio] 拒绝将诊断日志写入配置文件路径: ${path}\n`)
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (statSync(path).size >= MAX_DIAGNOSTIC_LOG_BYTES) {
        const backup = `${path}.1`
        rmSync(backup, { force: true })
        renameSync(path, backup)
        if (process.platform !== 'win32') chmodSync(backup, 0o600)
      }
    } catch { /* first write */ }
    const secrets = [...new Set([...collectConfigSecrets(config), ...extraSecrets])]
    const safeLabel = (value: string | undefined): string | undefined => (
      value ? sanitizeDiagnosticError(value, config, secrets).slice(0, 200) : undefined
    )
    // 白名单化事件字段，防止未来调用方把 prompt、路径或其它请求上下文
    // 作为额外属性传入后被对象展开意外写入日志。
    const safeEvent = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      source: event.source,
      outcome: event.outcome,
      modality: event.modality,
      ...(event.protocol ? { protocol: safeLabel(event.protocol) } : {}),
      ...(event.vendor ? { vendor: safeLabel(event.vendor) } : {}),
      ...(event.model ? { model: safeLabel(event.model) } : {}),
      elapsedMs: event.elapsedMs,
      ...(event.outputCount !== undefined ? { outputCount: event.outputCount } : {}),
      ...(event.error ? { error: sanitizeDiagnosticError(event.error, config, extraSecrets) } : {}),
    }
    appendFileSync(path, `${JSON.stringify(safeEvent)}\n`, { encoding: 'utf-8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch (err) {
    process.stderr.write(`[prismstudio] 写入诊断日志失败：${err instanceof Error ? err.message : String(err)}\n`)
  }
}
