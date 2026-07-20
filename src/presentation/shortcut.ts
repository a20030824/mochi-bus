import { QueryValidationError } from '../domain/bus-query'
import type { ETAResult } from '../lib/tdx'
import { publicErrorMessage } from './page-error'

export type ShortcutEtaSummary = Pick<ETAResult, 'routeName' | 'stopName' | 'label' | 'stale'>

export type ShortcutTextPresentation = {
  status: 200 | 400 | 503
  body: string
  shouldLog: boolean
}

/**
 * Format the compact plain-text ETA response shared by every shortcut alias.
 */
export function presentShortcutEta(result: ShortcutEtaSummary): ShortcutTextPresentation {
  return {
    status: 200,
    body: `${result.routeName}｜${result.stopName}\n${result.label}${result.stale ? '\n⚠️ 資料可能延遲' : ''}`,
    shouldLog: false,
  }
}

/**
 * Map a shortcut failure to its public text contract and boundary logging policy.
 */
export function presentShortcutError(error: unknown): ShortcutTextPresentation {
  return {
    status: error instanceof QueryValidationError ? 400 : 503,
    body: publicErrorMessage(error),
    shouldLog: true,
  }
}
