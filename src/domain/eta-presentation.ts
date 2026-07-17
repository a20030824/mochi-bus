export type EtaSource = 'realtime' | 'stale-realtime' | 'schedule' | 'none'

export type EtaTone = 'default' | 'estimated' | 'urgent'

export type EtaLabelParts = {
  prefix: string
  value: string
  suffix: string
}

export type EtaPresentation = EtaLabelParts & {
  tone: EtaTone
  stale: boolean
  numeric: boolean
}

const RELATIVE_ETA_PATTERN = /^(約\s*)?(\d+(?:[–-]\d+)?)(\s*分(?:後發車|一班)?)$/
const CLOCK_ETA_PATTERN = /^(明日\s+)?(\d{2}:\d{2})(\s*(?:到站|發車))$/
const TAIPEI_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function taipeiDateKey(date: Date): string {
  const parts = TAIPEI_DATE_FORMATTER.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function splitEtaLabel(label: string): EtaLabelParts {
  const trimmed = label.trim()
  const relative = trimmed.match(RELATIVE_ETA_PATTERN)
  if (relative) {
    return {
      prefix: relative[1]?.trim() ?? '',
      value: relative[2],
      suffix: relative[3].trim(),
    }
  }
  const clock = trimmed.match(CLOCK_ETA_PATTERN)
  if (clock) {
    return {
      prefix: clock[1]?.trim() ?? '',
      value: clock[2],
      suffix: clock[3].trim(),
    }
  }
  return { prefix: '', value: trimmed, suffix: '' }
}

export function etaPresentation(
  label: string,
  options: {
    source?: EtaSource
    estimateSeconds?: number | null
    stale?: boolean
  } = {},
): EtaPresentation {
  const source = options.source ?? 'none'
  const stale = options.stale === true || source === 'stale-realtime'
  const urgent = (source === 'realtime' || source === 'stale-realtime')
    && typeof options.estimateSeconds === 'number'
    && Number.isFinite(options.estimateSeconds)
    && options.estimateSeconds >= 0
    && options.estimateSeconds <= 180
  const parts = splitEtaLabel(label)
  return {
    ...parts,
    tone: source === 'schedule' ? 'estimated' : urgent ? 'urgent' : 'default',
    stale,
    numeric: /\d/.test(parts.value),
  }
}

export function formatJourneyWait(
  minutes: number | null | undefined,
  source: EtaSource = 'none',
  now = new Date(),
): string | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null
  const rounded = Math.max(0, Math.ceil(minutes))
  if (rounded > 60) {
    const arrival = new Date(now.getTime() + rounded * 60_000)
    const clock = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(arrival)
    const dayPrefix = taipeiDateKey(arrival) === taipeiDateKey(now) ? '' : '明日 '
    return `${dayPrefix}${clock} 到站`
  }
  return source === 'schedule' ? `約 ${Math.max(1, rounded)} 分` : `${rounded} 分到站`
}
