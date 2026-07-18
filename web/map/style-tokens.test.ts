// @ts-expect-error Vitest 執行於 Node；應用程式 tsconfig 刻意不載入 Node 全域型別。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const mapMain = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`Missing color token --${name}`)
  return match[1]
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
  return .2126 * red + .7152 * green + .0722 * blue
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}

describe('map design tokens', () => {
  it('keeps required muted text above WCAG AA on both map surfaces', () => {
    expect(contrast(token('text-muted'), token('paper'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('text-muted'), token('surface'))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps estimated timetable and ETA text readable on paper', () => {
    expect(contrast(token('ink-estimated'), token('paper'))).toBeGreaterThanOrEqual(4.5)
    expect(css).toContain('.timetable-minute.past')
    expect(css).toContain('var(--ink-urgent)')
  })

  it('keeps paper grain subtle, drawer-only, and non-interactive', () => {
    const opacity = Number(css.match(/--paper-grain-opacity:\s*([\d.]+)/)?.[1])
    expect(opacity).toBeGreaterThanOrEqual(.02)
    expect(opacity).toBeLessThanOrEqual(.04)
    expect(css).toMatch(/\.map-drawer::before\s*\{[^}]*pointer-events:\s*none/s)
    expect(css).not.toMatch(/#map::before|#map\s*\{[^}]*paper-grain/s)
  })

  it('does not reintroduce retired orphan colors or 10px labels', () => {
    expect(css).not.toContain('#847d70')
    expect(css).not.toContain('#55718a')
    expect(mapMain).not.toContain('#55718a')
    expect(css).not.toMatch(/font-size:\s*10px/)
  })
})
