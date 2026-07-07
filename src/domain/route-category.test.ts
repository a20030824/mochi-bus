import { describe, expect, it } from 'vitest'
import { classifyRouteName } from './route-category'

describe('classifyRouteName', () => {
  it.each(['307', '9', '202區', '９９'])('classifies %s as numeric', (name) => {
    expect(classifyRouteName(name)).toBe('數字')
  })

  it('keeps trunk routes separate', () => {
    expect(classifyRouteName('中山幹線')).toBe('幹線')
  })

  it.each(['藍29', '紅2', '綠17'])('classifies %s as a feeder route', (name) => {
    expect(classifyRouteName(name)).toBe('接駁')
  })

  it.each(['幸福大林1路', '樂活8路'])('classifies %s as a community route', (name) => {
    expect(classifyRouteName(name)).toBe('幸福／社區')
  })

  it('recognises Taiwan Tourist Shuttle names', () => {
    expect(classifyRouteName('台灣好行光林我嘉線(黃線)')).toBe('觀光')
  })

  it('recognises flexible taxi bus names', () => {
    expect(classifyRouteName('5公車式小黃')).toBe('小黃')
  })

  it('classifies THB routes as intercity buses regardless of name', () => {
    expect(classifyRouteName('5300', 'THB5300')).toBe('公路客運')
    expect(classifyRouteName('台灣好行日月潭線', 'THB6670')).toBe('公路客運')
  })

  it('keeps numeric city routes numeric when routeUid is not THB', () => {
    expect(classifyRouteName('307', 'TPE10132')).toBe('數字')
  })
})
