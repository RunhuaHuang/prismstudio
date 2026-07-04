import { describe, expect, test } from 'bun:test'
import { isLoopbackAuthority, validateLocalApiRequest } from './server'

describe('webui server · local API guard', () => {
  test('accepts same-origin loopback JSON writes', () => {
    expect(validateLocalApiRequest({
      method: 'PUT',
      host: '127.0.0.1:17899',
      origin: 'http://127.0.0.1:17899',
      secFetchSite: 'same-origin',
      contentType: 'application/json; charset=utf-8',
    })).toBeNull()
  })

  test('rejects cross-site browser requests', () => {
    expect(validateLocalApiRequest({
      method: 'POST',
      host: '127.0.0.1:17899',
      origin: 'https://evil.example',
      secFetchSite: 'cross-site',
      contentType: 'application/json',
    })).toContain('Origin')
  })

  test('requires JSON content type for mutating API calls', () => {
    expect(validateLocalApiRequest({
      method: 'POST',
      host: 'localhost:17899',
      origin: 'http://localhost:17899',
      secFetchSite: 'same-origin',
      contentType: 'text/plain',
    })).toContain('application/json')
  })

  test('only loopback authorities are allowed', () => {
    expect(isLoopbackAuthority('127.0.0.1:17899')).toBe(true)
    expect(isLoopbackAuthority('localhost:17899')).toBe(true)
    expect(isLoopbackAuthority('0.0.0.0:17899')).toBe(false)
    expect(isLoopbackAuthority('example.com')).toBe(false)
  })
})
