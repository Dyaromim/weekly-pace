import { describe, expect, test } from 'claude-code/testing'

import { HOUR_MS, WEEK_HOURS, WEEK_MS, lightFor, linearCurve, observedCurves, pace, transcriptCurve, usualCurve } from '../hooks/pace'
import type { HourlyUsage, QuotaSample } from '../types'

// A window that resets on a Monday 00:00 UTC boundary (hour-aligned).
const RESETS_AT = Date.UTC(2026, 9, 19)
const START = RESETS_AT - WEEK_MS

const rounded = (value: number | null | undefined) => Math.round((value ?? NaN) * 1000) / 1000

/** Past weeks where all usage falls on the window's first two days. */
const frontLoaded = (weeks: number): HourlyUsage => {
  const hourly: HourlyUsage = {}
  for (let k = 1; k <= weeks; k++) {
    const startHour = (START - k * WEEK_MS) / HOUR_MS
    for (let i = 0; i < 48; i++) hourly[startHour + i] = 10
  }
  return hourly
}

describe('transcriptCurve', () => {
  test('is null with no history', async () => {
    expect(transcriptCurve({}, RESETS_AT)).toBe(null)
  })

  test('follows the usual shape of past weeks', async () => {
    const curve = transcriptCurve(frontLoaded(4), RESETS_AT)!
    expect(curve[0]).toBe(0)
    expect(rounded(curve[24])).toBe(0.5)
    expect(rounded(curve[48])).toBe(1)
    expect(rounded(curve[WEEK_HOURS])).toBe(1)
  })

  test('ignores a vacation week', async () => {
    const hourly = frontLoaded(4)
    // A near-empty week whose little usage lands late in the window.
    hourly[(START - 5 * WEEK_MS) / HOUR_MS + 160] = 1
    expect(rounded(transcriptCurve(hourly, RESETS_AT)![48])).toBe(1)
  })
})

describe('observedCurves', () => {
  test('skips the running window and windows seen only early', async () => {
    const samples: QuotaSample[] = [
      { t: START + HOUR_MS, pct: 3, resetsAt: RESETS_AT },
      { t: START - WEEK_MS + 10 * HOUR_MS, pct: 30, resetsAt: START },
    ]
    expect(observedCurves(samples, START + 2 * HOUR_MS)).toEqual([])
  })

  test('normalizes a finished window to its final reading', async () => {
    const prevStart = START - WEEK_MS
    const samples: QuotaSample[] = [
      { t: prevStart + 84 * HOUR_MS, pct: 40, resetsAt: START },
      { t: prevStart + 160 * HOUR_MS, pct: 80, resetsAt: START },
    ]
    const [curve] = observedCurves(samples, START + HOUR_MS)
    expect(rounded(curve![84])).toBe(0.5)
    expect(rounded(curve![WEEK_HOURS])).toBe(1)
  })
})

describe('usualCurve', () => {
  test('is a straight line with no data', async () => {
    expect(usualCurve({}, [], RESETS_AT, START)).toEqual(linearCurve())
  })
})

describe('lightFor', () => {
  test('green within 10% over target', async () => {
    expect(lightFor(54, 50)).toBe('green')
  })
  test('yellow within 25% over target', async () => {
    expect(lightFor(60, 50)).toBe('yellow')
  })
  test('red past 25% over target', async () => {
    expect(lightFor(70, 50)).toBe('red')
  })
  test('tolerates a few points early in the week', async () => {
    expect(lightFor(3, 1)).toBe('green')
    expect(lightFor(5, 1)).toBe('yellow')
    expect(lightFor(7, 1)).toBe('red')
  })
})

describe('pace', () => {
  test('targets the usual share at this hour and projects the week', async () => {
    const curve = transcriptCurve(frontLoaded(4), RESETS_AT)!
    const result = pace(30, curve, RESETS_AT, START + 24 * HOUR_MS)
    expect(rounded(result.target)).toBe(50)
    expect(result.light).toBe('green')
    expect(rounded(result.projected)).toBe(60)
  })

  test('has no projection in the first hours of a linear week', async () => {
    expect(pace(1, linearCurve(), RESETS_AT, START + HOUR_MS).projected).toBe(null)
  })
})
