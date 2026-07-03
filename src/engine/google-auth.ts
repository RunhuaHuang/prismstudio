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

async function exchangeGoogleServiceAccountToken(serviceAccount: GoogleServiceAccountJson): Promise<string> {
  const clientEmail = getString(serviceAccount.client_email)
  const privateKey = getString(serviceAccount.private_key)
  const tokenUri = getString(serviceAccount.token_uri) ?? DEFAULT_GOOGLE_TOKEN_URI
  if (!clientEmail || !privateKey) {
    throw new Error('Vertex JSON 缺少 client_email 或 private_key')
  }

  const cacheKey = `service:${clientEmail}:${tokenUri}:${GOOGLE_CLOUD_SCOPE}`
  const cached = googleTokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken

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

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: unknown }
  if (!response.ok || !data.access_token) {
    throw new Error(`Vertex OAuth token exchange failed: ${response.status} ${JSON.stringify(data.error ?? data)}`)
  }

  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600
  googleTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  })
  return data.access_token
}

async function exchangeGoogleAuthorizedUserToken(credential: GoogleAuthorizedUserJson): Promise<string> {
  const clientId = getString(credential.client_id)
  const clientSecret = getString(credential.client_secret)
  const refreshToken = getString(credential.refresh_token)
  const tokenUri = getString(credential.token_uri) ?? DEFAULT_GOOGLE_TOKEN_URI
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Vertex authorized_user JSON 缺少 client_id、client_secret 或 refresh_token')
  }

  const cacheKey = `user:${clientId}:${refreshToken}:${tokenUri}`
  const cached = googleTokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  })
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: unknown }
  if (!response.ok || !data.access_token) {
    throw new Error(`Vertex OAuth refresh failed: ${response.status} ${JSON.stringify(data.error ?? data)}`)
  }

  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600
  googleTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  })
  return data.access_token
}

// ===== 凭据解析 =====

/** 判断凭据是否为 Google Cloud JSON（service_account 或 authorized_user） */
export function isGoogleVertexJsonCredential(rawCredential: string): boolean {
  const credential = readJsonCredential(rawCredential)
  if (!credential) return false
  return credential.type === 'service_account' || credential.type === 'authorized_user'
}

/** 解析凭据：JSON → OAuth token；纯字符串 → API Key */
export async function resolveGoogleUpstreamAuth(rawCredential: string): Promise<GoogleUpstreamAuth> {
  const credential = readJsonCredential(rawCredential)
  if (!credential) return { kind: 'api-key', apiKey: rawCredential.trim() }

  const directApiKey =
    getString(credential.GOOGLE_API_KEY) ??
    getString(credential.GEMINI_API_KEY) ??
    getString(credential.api_key) ??
    getString(credential.apiKey)
  if (directApiKey) return { kind: 'api-key', apiKey: directApiKey }

  if (credential.type === 'service_account') {
    return {
      kind: 'oauth',
      accessToken: await exchangeGoogleServiceAccountToken(credential as GoogleServiceAccountJson),
      projectId: getString(credential.project_id),
    }
  }

  if (credential.type === 'authorized_user') {
    return {
      kind: 'oauth',
      accessToken: await exchangeGoogleAuthorizedUserToken(credential as GoogleAuthorizedUserJson),
      projectId: getString(credential.quota_project_id),
    }
  }

  return { kind: 'api-key', apiKey: rawCredential.trim() }
}

// ===== URL 规范化 =====

function isGoogleAiplatformHost(hostname: string): boolean {
  return hostname === 'aiplatform.googleapis.com' || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/i.test(hostname)
}

function normalizeGoogleAiplatformModelGardenHost(hostname: string): string {
  return hostname.toLowerCase() === 'global-aiplatform.googleapis.com' ? 'aiplatform.googleapis.com' : hostname
}

function stripKnownProviderEndpoint(pathname: string): string {
  const endpointSuffixes = ['/chat/completions', '/responses', '/messages', '/models', '/images/generations', '/images/edits']
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
    return fallback
  }
}

// ===== Vertex URL 构造 =====

export function resolveGoogleVertexGenerateContentUrl(input: { baseUrl?: string; modelId: string; projectId?: string }): string {
  const modelId = encodeURIComponent(input.modelId)
  const baseUrl = input.baseUrl?.trim()
  const projectId = input.projectId?.trim()

  if (baseUrl) {
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
      // fall through
    }
  }

  if (!projectId) {
    throw new Error('Vertex JSON 需要 project_id，或 Base URL 需要包含完整 Vertex generateContent 路径')
  }
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/${modelId}:generateContent`
}

function resolveGoogleVertexPredictLongRunningUrl(input: { baseUrl?: string; modelId: string; projectId?: string }): string {
  return resolveGoogleVertexGenerateContentUrl(input).replace(/:generateContent$/, ':predictLongRunning')
}

function resolveGoogleVertexInteractionsUrl(input: { baseUrl?: string; projectId?: string }): string {
  const baseUrl = input.baseUrl?.trim()
  const projectId = input.projectId?.trim()

  if (baseUrl) {
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
      // fall through
    }
  }

  if (!projectId) {
    throw new Error('Vertex JSON 需要 project_id，或 Base URL 需要包含完整 Vertex interactions 路径')
  }
  return `https://aiplatform.googleapis.com/v1beta/projects/${encodeURIComponent(projectId)}/locations/global/interactions`
}

// ===== Request Target Builder（媒体生成专用） =====

/** Gemini Image generateContent 请求目标（API Key → ?key=；Vertex → OAuth Bearer） */
export async function buildGoogleGenerateContentRequestTarget(input: {
  rawCredential: string
  baseUrl?: string
  modelId: string
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential)
  if (auth.kind === 'api-key') {
    const root = normalizeGoogleGeminiApiRoot(input.baseUrl)
    const url = new URL(`${root.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(input.modelId)}:generateContent`)
    url.searchParams.set('key', auth.apiKey)
    return {
      url: url.toString(),
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
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential)
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
}): Promise<{ url: string; headers: Record<string, string>; authKind: GoogleUpstreamAuth['kind'] }> {
  const auth = await resolveGoogleUpstreamAuth(input.rawCredential)
  if (auth.kind === 'api-key') {
    const root = normalizeGoogleGeminiApiRoot(input.baseUrl)
    const url = new URL(`${root.replace(/\/+$/, '')}/v1beta/interactions`)
    url.searchParams.set('key', auth.apiKey)
    return {
      url: url.toString(),
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
