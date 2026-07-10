import { describe, expect, it } from 'vitest'
import {
  ApiInputError,
  parseCoordinate,
  parseJourneyEtaInput,
  parseOptionalDirection,
  parseRadius,
  parseTdxCredentials,
  readJsonBody,
} from './api-input'

const cities = new Set(['Taipei', 'NewTaipei'])

describe('journey ETA input', () => {
  it('parses and trims a valid request', () => {
    expect(parseJourneyEtaInput({
      city: ' Taipei ',
      legs: [{ key: ' direct:0 ', patternId: ' TPE123:0:0 ', sequence: 4 }],
    }, cities)).toEqual({
      city: 'Taipei',
      legs: [{ key: 'direct:0', patternId: 'TPE123:0:0', sequence: 4 }],
    })
  })

  it('rejects a partially valid list instead of silently filtering it', () => {
    expect(() => parseJourneyEtaInput({
      city: 'Taipei',
      legs: [
        { key: 'valid', patternId: 'TPE123:0:0', sequence: 1 },
        { key: '', patternId: 'TPE123:0:0', sequence: 1 },
      ],
    }, cities)).toThrow(ApiInputError)
  })

  it('rejects duplicate client keys and unreasonable stop sequences', () => {
    expect(() => parseJourneyEtaInput({
      city: 'Taipei',
      legs: [
        { key: 'same', patternId: 'A', sequence: 1 },
        { key: 'same', patternId: 'B', sequence: 2 },
      ],
    }, cities)).toThrow('ETA key 不可重複')
    expect(() => parseJourneyEtaInput({
      city: 'Taipei',
      legs: [{ key: 'a', patternId: 'A', sequence: 10_001 }],
    }, cities)).toThrow('站序必須是 0 到 10000 的整數')
  })
})

describe('JSON request parsing', () => {
  it('accepts JSON media types and rejects unsupported or malformed bodies', async () => {
    const valid = new Request('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
      body: '{"ok":true}',
    })
    await expect(readJsonBody(valid)).resolves.toEqual({ ok: true })

    const unsupported = new Request('https://example.com', { method: 'POST', body: '{}' })
    await expect(readJsonBody(unsupported)).rejects.toMatchObject({ status: 415 })

    const malformed = new Request('https://example.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    await expect(readJsonBody(malformed)).rejects.toMatchObject({ status: 400 })
  })
})

describe('query and credential boundaries', () => {
  it('validates coordinate and radius ranges without NaN coercion', () => {
    expect(parseCoordinate('25.04', 'latitude')).toBe(25.04)
    expect(parseCoordinate('121.5', 'longitude')).toBe(121.5)
    expect(() => parseCoordinate('', 'latitude')).toThrow(ApiInputError)
    expect(() => parseCoordinate('91', 'latitude')).toThrow(ApiInputError)
    expect(() => parseRadius('NaN')).toThrow(ApiInputError)
    expect(() => parseRadius('49')).toThrow(ApiInputError)
    expect(parseRadius(undefined)).toBe(500)
  })

  it('accepts only optional directions 0 and 1', () => {
    expect(parseOptionalDirection(undefined)).toBeUndefined()
    expect(parseOptionalDirection('1')).toBe(1)
    expect(() => parseOptionalDirection('2')).toThrow(ApiInputError)
  })

  it('requires a complete, bounded TDX credential pair', () => {
    expect(parseTdxCredentials(undefined, undefined)).toBeNull()
    expect(() => parseTdxCredentials('id', undefined)).toThrow(ApiInputError)
    expect(() => parseTdxCredentials('x'.repeat(121), 'secret')).toThrow(ApiInputError)
    expect(parseTdxCredentials(' id ', ' secret ', true)).toEqual({ clientId: 'id', clientSecret: 'secret' })
  })
})
