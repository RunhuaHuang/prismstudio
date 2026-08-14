/**
 * Google Cloud / AI Studio 凭据解析与请求构造（独立版）
 *
 * 从 RunAI 的 agent-upstream-auth.ts 提取 Google 专属逻辑（不含 OpenAI/Codex），
 * 支持 AI Studio API Key 与 Google Cloud Service Account / Authorized User JSON 凭据双路径。
 *
 * 支持的凭据形式：
 *  - AI Studio API Key（纯字符串，如 "AIza..."）
 *  - Service Account JSON（粘贴 JSON 文本、`file:/path/to/key.json`、或文件路径）
 *  - Authorized User JSON（同上）
 *  - JSON 内含 `GOOGLE_API_KEY` / `GEMINI_API_KEY` / `api_key` 字段时按 API Key 处理
 *
 * Service Account 会用 RS256 JWT 换取 OAuth access_token；Authorized User 用 refresh_token 刷新。
 * Token 缓存在内存（含过期时间，提前 60s 刷新）。
 */

import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

type JsonObject = Record<string, unknown>

export type GoogleUpstreamAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; accessToken: string; projectId?: string }

interface GoogleServiceAccountJson {
  type?: string
  project_id?: string
  private_key?: string
  client_email?: string
  token_uri?: string
}

interface GoogleAuthorizedUserJson {
  type?: string
  client_id?: string
  client_secret?: string
  refresh_token?: string
  token_uri?: string
  quota_project_id?: string
}

const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const googleTokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>()

const GOOGLE_TOKEN_HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com'])

/**
 * 校验凭据 JSON 中的 token_uri。
 * OAuth token 交换会携带 JWT assertion、client secret 或 refresh token，
 * 因此不能允许凭据文件把这些内容转发到任意 HTTP/本机地址。
 */
export function validateGoogleTokenUri(rawTokenUri?: string): string {
  const value = rawTokenUri?.trim() || DEFAULT_GOOGLE_TOKEN_URI
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Google OAuth token_uri 无效：必须是 Google 官方 HTTPS 地址')
  }
  if (url.protocol !== 'https:' || !GOOGLE_TOKEN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Google OAuth token_uri 不受信任：只允许 oauth2.googleapis.com 或 www.googleapis.com 的 HTTPS 地址')
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Google OAuth token_uri 不安全：禁止端口、用户名密码、query 或 hash')
  }
  return url.toString()
}

// ===== 工具函数 =====

function expandPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

function tryParseJson(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null
  } catch {
    return null
  }
}

function readJsonCredential(rawCredential: string): JsonObject | null {
  const trimmed = rawCredential.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    return tryParseJson(trimmed)
  }

  const maybePath = trimmed.startsWith('file:') ? trimmed.slice('file:'.length) : trimmed
  if (!maybePath.includes('/') && !maybePath.endsWith('.json')) return null

  const credentialPath = expandPath(maybePath)
  if (!existsSync(credentialPath)) return null

  return tryParseJson(readFileSync(credentialPath, 'utf-8'))
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

// ===== OAuth Token 交换 =====

const inflightTokenRefreshes = new Map<string, Promise<string>>()

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

function resolveExpiresInSeconds(expiresIn: unknown): number {
  // 兼容 number 与字符串形式（部分网关返回 "3600"）；非有限/非正值回退 3600。
  const asNumber = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn)
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : 3600
}

/** 读取 token 端点响应：只吞 JSON 解析错误；AbortError 必须向上传播，否则用户取消会被误报为认证失败。 */
async function readTokenResponse(response: Response, signal?: AbortSignal): Promise<{
  access_token?: string
  expires_in?: unknown
  error?: unknown
  error_description?: string
}> {
  try {
    return await response.json() as { access_token?: string; expires_in?: unknown; error?: unknown; error_description?: string }
  } catch (err) {
    if (isAbortError(err, signal)) throw err
    return {}
  }
}

/** 执行一次 token 端点交换；对网络层错误与 5xx 瞬态错误重试一次。 */
async function fetchGoogleToken(
  tokenUri: string,
  params: URLSearchParams,
  signal: AbortSignal | undefined,
  label: string,
): Promise<{ accessToken: string; expiresAtMs: number }> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params,
        signal,
      })
    } catch (err) {
      // 用户主动取消必须立即传播，不重试。
      if (isAbortError(err, signal)) throw err
      // fetch 抛出的网络层错误（TypeError）首次短退避后重试一次。
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        lastError = err instanceof Error ? err : new Error(String(err))
        continue
      }
      throw err
    }
    const data = await readTokenResponse(response, signal)
    if (response.ok && data.access_token) {
      return {
        accessToken: data.access_token,
        expiresAtMs: Date.now() + resolveExpiresInSeconds(data.expires_in) * 1000,
      }
    }
    const desc = data.error_description ? ` (${data.error_description})` : ''
    lastError = new Error(`${label}失败 (HTTP ${response.status}): ${JSON.stringify(data.error ?? data)}${desc}`)
    // 5xx 是服务端瞬态错误，首次失败短退避后重试一次。
    if (attempt === 0 && response.status >= 500 && response.status < 600) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      continue
    }
    throw lastError
  }
  throw lastError ?? new Error(`${label}失败`)
}

/**
 * 并发刷新去重：缓存失效后若 N 个请求同时到达，只执行一次 token 交换，其余复用结果。
 * 交换失败时清除陈旧缓存，避免持续命中坏值；in-flight 条目在完成后立即移除。
 */
async function dedupedTokenRefresh(
  cacheKey: string,
  refresh: () => Promise<{ accessToken: string; expiresAtMs: number }>,
): Promise<string> {
  const existing = inflightTokenRefreshes.get(cacheKey)
  if (existing) return existing
  const pending = (async () => {
    try {
      const result = await refresh()
      googleTokenCache.set(cacheKey, result)
      return result.accessToken
    } catch (err) {
      googleTokenCache.delete(cacheKey)
      throw err
    }
  })()
  inflightTokenRefreshes.set(cacheKey, pending)
  try {
    return await pending
  } finally {
    inflightTokenRefreshes.delete(cacheKey)
  }
}

async function exchangeGoogleServiceAccountToken(serviceAccount: GoogleServiceAccountJson, signal?: AbortSignal): Promise<string> {
  const clientEmail = getString(serviceAccount.client_email)
  const privateKey = getString(serviceAccount.private_key)
  const tokenUri = validateGoogleTokenUri(serviceAccount.token_uri)
  if (!clientEmail || !privateKey) {
    throw new Error('Vertex JSON 缺少 client_email 或 private_key')
  }

  const cacheKey = `service:${clientEmail}:${tokenUri}:${GOOGLE_CLOUD_SCOPE}`
  const cached = googleTokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken

  return dedupedTokenRefresh(cacheKey, async () => {
    const now = Math.floor(Date.now() / 1000)
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64Url(JSON.stringify({
      iss: clientEmail,
      scope: GOOGLE_CLOUD_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }))
    const unsignedJwt = `${header}.${claims}`
    const signature = createSign('RSA-SHA256').update(unsignedJwt).sign(privateKey)
    const assertion = `${unsignedJwt}.${base64Url(signature)}`
    return fetchGoogleToken(
      tokenUri,
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal,
      'Vertex OAuth token 交换',
    )
  })
}

async function exchangeGoogleAuthorizedUserToken(credential: GoogleAuthorizedUserJson, signal?: AbortSignal): Promise<string> {
  const clientId = getString(credential.client_id)
  const clientSecret = getString(credential.client_secret)
  const refreshToken = getString(credential.refresh_token)
  const tokenUri = validateGoogleTokenUri(credential.token_uri)
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Vertex authorized_user JSON 缺少 client_id、client_secret 或 refresh_token')
  }

  const cacheKey = `user:${clientId}:${refreshToken}:${tokenUri}`
  const cached = googleTokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken

  return dedupedTokenRefresh(cacheKey, () => fetchGoogleToken(
    tokenUri,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal,
    'Vertex OAuth token 刷新',
  ))
}

// ===== 凭据解析 =====

/** 判断凭据是否为 Google Cloud JSON（service_account 或 authorized_user） */
export function isGoogleVertexJsonCredential(rawCredential: string): boolean {
  const credential = readJsonCredential(rawCredential)
  if (!credential) return false
  return credential.type === 'service_account' || credential.type === 'authorized_user'
}

/** 解析凭据：JSON → OAuth token；纯字符串 → API Key */
export async function resolveGoogleUpstreamAuth(rawCredential: string, signal?: AbortSignal): Promise<GoogleUpstreamAuth> {
  const credential = readJsonCredential(rawCredential)
  if (!credential) {
    // 形似文件路径却读取/解析失败时给出可操作的错误，而不是把路径当 API Key 发给 Google
    // 拿到一个无意义的 400（如 "x-goog-api-key: /wrong/path/key.json"）。
    const maybePath = rawCredential.trim().startsWith('file:') ? rawCredential.trim().slice('file:'.length) : rawCredential.trim()
    if (maybePath.includes('/') || maybePath.endsWith('.json')) {
      throw new Error(`Google 凭据文件不存在或无法解析为 JSON: ${maybePath}`)
    }
    return { kind: 'api-key', apiKey: rawCredential.trim() }
  }

  const directApiKey =
    getString(credential.GOOGLE_API_KEY) ??
    getString(credential.GEMINI_API_KEY) ??
    getString(credential.api_key) ??
    getString(credential.apiKey)
  if (directApiKey) return { kind: 'api-key', apiKey: directApiKey }

  if (credential.type === 'service_account') {
    return {
      kind: 'oauth',
      accessToken: await exchangeGoogleServiceAccountToken(credential as GoogleServiceAccountJson, signal),
      projectId: getString(credential.project_id),
    }
  }

  if (credential.type === 'authorized_user') {
    return {
      kind: 'oauth',
      accessToken: await exchangeGoogleAuthorizedUserToken(credential as GoogleAuthorizedUserJson, signal),
      projectId: getString(credential.quota_project_id),
    }
  }

  return { kind: 'api-key', apiKey: rawCredential.trim() }
}

// ===== URL 规范化 =====

function isGoogleAiplatformHost(hostname: string): boolean {
  return hostname === 'aiplatform.googleapis.com' || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/i.test(hostname)
}

function stripKnownProviderEndpoint(pathname: string): string {
  const endpointSuffixes = ['/chat/completions', '/responses', '/messages', '/models', '/images/generations', '/images/edits', '/interactions']
  for (const suffix of endpointSuffixes) {
    if (pathname.endsWith(suffix)) return pathname.slice(0, -suffix.length)
  }
  return pathname
}

/** 规范化 Gemini API root（内联自 @run/core url-utils，去掉依赖） */
export function normalizeGoogleGeminiApiRoot(baseUrl?: string): string {
  const fallback = 'https://generativelanguage.googleapis.com'
  if (!baseUrl?.trim()) return fallback

  try {
    const url = new URL(baseUrl)
    let pathname = url.pathname.replace(/\/+$/, '')
    const modelEndpointMatch = pathname.match(/^(.*)\/v1(?:beta\d*)?\/models(?:\/.*)?$/i)
    if (modelEndpointMatch?.[1] !== undefined) {
      pathname = modelEndpointMatch[1]
    } else {
      pathname = stripKnownProviderEndpoint(pathname)
    }
    if (/\/v1(?:beta\d*)?$/i.test(pathname)) {
      pathname = pathname.replace(/\/v1(?:beta\d*)?$/i, '')
    }
    url.pathname = pathname.replace(/\/+$/, '') || '/'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new Error(`Gemini Base URL 无效: ${baseUrl}`)
  }
}

// ===== Vertex URL 构造 =====

export function resolveGoogleVertexGenerateContentUrl(input: { baseUrl?: string; modelId: string; projectId?: string }): string {
  const modelId = encodeURIComponent(input.modelId)
  const baseUrl = input.baseUrl?.trim()
  const projectId = input.projectId?.trim()

  if (baseUrl) {
    let parsedOk = true
    try {
      const url = new URL(baseUrl)
      url.search = ''
      if (url.pathname.includes('{model}')) {
        url.pathname = url.pathname.replace('{model}', modelId)
      }
      if (url.pathname.endsWith(':streamGenerateContent')) {
        url.pathname = url.pathname.slice(0, -':streamGenerateContent'.length) + ':generateContent'
        return url.toString()
      }
      // Veo predictLongRunning 完整端点：不能落入下方 /publishers/google/models/ 分支被二次追加。
      if (url.pathname.endsWith(':predictLongRunning')) return url.toString()
      if (url.pathname.endsWith(':generateContent')) return url.toString()

      const trimmedPath = url.pathname.replace(/\/+$/, '')
      if (trimmedPath.includes('/publishers/google/models/')) {
        url.pathname = `${trimmedPath}:generateContent`
        return url.toString()
      }
      if (trimmedPath.includes('/projects/') && trimmedPath.includes('/locations/')) {
        url.pathname = `${trimmedPath}/publishers/google/models/${modelId}:generateContent`
        return url.toString()
      }
      if (projectId && isGoogleAiplatformHost(url.hostname)) {
        const location = url.hostname.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/i)?.[1] ?? 'global'
        url.pathname = `/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${modelId}:generateContent`
        return url.toString()
      }
    } catch {
      parsedOk = false
    }
    // 用户显式配置了自定义 baseUrl，但既不是 aiplatform 官方域名、pathname 又没含
    // /projects/.../locations/ 结构：不能静默丢弃 baseUrl 直接请求官方域名（会绕过
    // 企业代理），应给出明确错误让用户修正配置。
    if (parsedOk) {
      throw new Error(`无法从 Base URL 解析 Vertex 请求路径: ${baseUrl}。请填写官方 aiplatform 域名，或包含 /projects/.../locations/ 的完整端点路径`)
    }
  }

  if (!projectId) {
    throw new Error('Vertex JSON 需要 project_id，或 Base URL 需要包含完整 Vertex generateContent 路径')
  }
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/${modelId}:generateContent`
}

function resolveGoogleVertexPredictLongRunningUrl(input: { baseUrl?: string; modelId: string; projectId?: string }): string {
  const baseUrl = input.baseUrl?.trim()
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (url.pathname.endsWith(':predictLongRunning')) {
        url.search = ''
        return url.toString()
      }
    } catch {
      // fall through
    }
  }
  return resolveGoogleVertexGenerateContentUrl(input).replace(/:generateContent$/, ':predictLongRunning')
}

function resolveGoogleVertexInteractionsUrl(input: { baseUrl?: string; projectId?: string }): string {
  const baseUrl = input.baseUrl?.trim()
  const projectId = input.projectId?.trim()

  if (baseUrl) {
    let parsedOk = true
    try {
      const url = new URL(baseUrl)
      url.search = ''
      const trimmedPath = url.pathname.replace(/\/+$/, '')
      if (trimmedPath.endsWith('/interactions')) return url.toString()
      const vertexPrefixMatch = trimmedPath.match(/^(.*\/v\d+(?:beta\d*)?\/projects\/[^/]+\/locations\/[^/]+)(?:\/.*)?$/i)
      if (vertexPrefixMatch?.[1]) {
        url.pathname = `${vertexPrefixMatch[1]}/interactions`
        return url.toString()
      }
      if (projectId && isGoogleAiplatformHost(url.hostname)) {
        const location = url.hostname.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/i)?.[1] ?? 'global'
        url.pathname = `/v1beta/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/interactions`
        return url.toString()
      }
    } catch {
      parsedOk = false
    }
    // 与 generateContent 一致：自定义 baseUrl 无法解析时给出明确错误，而非静默丢弃。
    if (parsedOk) {
      throw new Error(`无法从 Base URL 解析 Vertex interactions 路径: ${baseUrl}。请填写官方 aiplatform 域名，或包含 /projects/.../locations/ 的完整端点路径`)
    }
  }

  if (!projectId) {
    throw new Error('Vertex JSON 需要 project_id，或 Base URL 需要包含完整 Vertex interactions 路径')
  }
  return `https://aiplatform.googleapis.com/v1beta/projects/${encodeURIComponent(projectId)}/locations/global/interactions`
}

// ===== Request Target Builder（媒体生成专用） =====

/** Gemini Image generateContent 请求目标（API Key → x-goog-api-key 头；Vertex → OAuth Bearer） */
export async function buildGoogleGenerateContentRequestTarget(input: {
  rawCredential: string
  baseUrl?: string
  modelId: string
  signal?: AbortSignal
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential, input.signal)
  if (auth.kind === 'api-key') {
    const root = normalizeGoogleGeminiApiRoot(input.baseUrl)
    // 只用 x-goog-api-key 头认证，不把 key 放进 URL query，
    // 避免被代理/网关访问日志、客户端请求行日志持续复制泄漏。
    const url = `${root.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(input.modelId)}:generateContent`
    return {
      url,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': auth.apiKey },
      authKind: auth.kind,
    }
  }

  const vertexUrl = resolveGoogleVertexGenerateContentUrl({ baseUrl: input.baseUrl, modelId: input.modelId, projectId: auth.projectId })
  return {
    url: vertexUrl,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
    authKind: auth.kind,
  }
}

/** Veo predictLongRunning 请求目标 */
export async function buildGooglePredictLongRunningRequestTarget(input: {
  rawCredential: string
  baseUrl?: string
  modelId: string
  signal?: AbortSignal
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential, input.signal)
  if (auth.kind === 'api-key') {
    const root = normalizeGoogleGeminiApiRoot(input.baseUrl)
    return {
      url: `${root.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(input.modelId)}:predictLongRunning`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': auth.apiKey },
      authKind: auth.kind,
    }
  }

  return {
    url: resolveGoogleVertexPredictLongRunningUrl({ baseUrl: input.baseUrl, modelId: input.modelId, projectId: auth.projectId }),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${auth.accessToken}`, ...(auth.projectId ? { 'x-goog-user-project': auth.projectId } : {}) },
    authKind: auth.kind,
  }
}

/** Gemini Omni interactions 请求目标 */
export async function buildGoogleInteractionsRequestTarget(input: {
  rawCredential: string
  baseUrl?: string
  signal?: AbortSignal
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential, input.signal)
  if (auth.kind === 'api-key') {
    const root = normalizeGoogleGeminiApiRoot(input.baseUrl)
    // 同 generateContent：仅用请求头认证，key 不进 URL。
    const url = `${root.replace(/\/+$/, '')}/v1beta/interactions`
    return {
      url,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': auth.apiKey },
      authKind: auth.kind,
    }
  }

  return {
    url: resolveGoogleVertexInteractionsUrl({ baseUrl: input.baseUrl, projectId: auth.projectId }),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${auth.accessToken}`, ...(auth.projectId ? { 'x-goog-user-project': auth.projectId } : {}) },
    authKind: auth.kind,
  }
}
