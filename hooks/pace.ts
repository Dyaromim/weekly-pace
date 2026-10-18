// Pure pacing math: the expected share of the weekly quota at a point in the window,
// learned from past weeks, and the traffic light against it. No `$` here, so it tests directly.
import type { HourlyUsage, QuotaSample } from '../types'

export const HOUR_MS = 3_600_000
export const WEEK_HOURS = 168
export const WEEK_MS = WEEK_HOURS * HOUR_MS

const PAST_WEEKS = 12
// Observed quota readings beat transcript estimates; from this many full weeks on they rule alone.
const OBSERVED_WEEKS_TO_TRUST = 3
// A week used this little (vs. the median week) is a vacation, not a pattern.
const QUIET_WEEK_SHARE = 0.2

/** Cumulative share of the week's usage at each hour: curve[0] = 0, curve[168] = 1. */
export type Curve = number[]

export type Light = 'green' | 'yellow' | 'red'

export type Pace = {
  /** Percent of the quota your usual week has used by now. */
  target: number
  light: Light
  /** Percent you end the week at if the rest of it follows your usual pattern. */
  projected: number | null
}

export const linearCurve = (): Curve =>
  Array.from({ length: WEEK_HOURS + 1 }, (_, h) => h / WEEK_HOURS)

const cumulative = (buckets: number[]): Curve => {
  const total = buckets.reduce((sum, v) => sum + v, 0)
  const curve = [0]
  let running = 0
  for (const v of buckets) curve.push((running += v) / total)
  return curve
}

const average = (curves: Curve[]): Curve =>
  linearCurve().map((_, h) => curves.reduce((sum, c) => sum + (c[h] ?? 0), 0) / curves.length)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** The usual week from transcript usage, aligned to the quota window that ends at `resetsAt`. */
export const transcriptCurve = (hourly: HourlyUsage, resetsAt: number): Curve | null => {
  const currentStart = resetsAt - WEEK_MS
  const weeks: number[][] = []
  for (let k = 1; k <= PAST_WEEKS; k++) {
    const startHour = Math.floor((currentStart - k * WEEK_MS) / HOUR_MS)
    weeks.push(Array.from({ length: WEEK_HOURS }, (_, i) => hourly[startHour + i] ?? 0))
  }
  const totals = weeks.map(w => w.reduce((sum, v) => sum + v, 0))
  const floor = median(totals.filter(t => t > 0)) * QUIET_WEEK_SHARE
  const usual = weeks.filter((_, i) => (totals[i] ?? 0) > 0 && (totals[i] ?? 0) >= floor)
  return usual.length === 0 ? null : average(usual.map(cumulative))
}

/** The usual week from seven_day readings of finished windows. */
export const observedCurves = (samples: QuotaSample[], now: number): Curve[] => {
  const byWindow = new Map<number, QuotaSample[]>()
  for (const s of samples) {
    if (s.resetsAt > now) continue
    byWindow.set(s.resetsAt, [...(byWindow.get(s.resetsAt) ?? []), s])
  }
  const curves: Curve[] = []
  for (const [resetsAt, window] of byWindow) {
    const start = resetsAt - WEEK_MS
    const points = window
      .map(s => ({ h: (s.t - start) / HOUR_MS, pct: s.pct }))
      .sort((a, b) => a.h - b.h)
    const final = Math.max(...points.map(p => p.pct))
    // A window seen only at its start says nothing about how the week unfolds.
    if (final < 5 || (points[points.length - 1]?.h ?? 0) < WEEK_HOURS - 24) continue
    const known = [{ h: 0, pct: 0 }, ...points, { h: WEEK_HOURS, pct: final }]
    curves.push(
      Array.from({ length: WEEK_HOURS + 1 }, (_, h) => {
        const after = known.findIndex(p => p.h >= h)
        const b = known[after]!
        const a = known[Math.max(after - 1, 0)]!
        const t = b.h === a.h ? 1 : (h - a.h) / (b.h - a.h)
        return Math.min((a.pct + t * (b.pct - a.pct)) / final, 1)
      }),
    )
  }
  return curves
}

/** Observed weeks phase in over transcript ones; a straight line until either exists. */
export const usualCurve = (
  hourly: HourlyUsage,
  samples: QuotaSample[],
  resetsAt: number,
  now: number,
): Curve => {
  const fromTranscripts = transcriptCurve(hourly, resetsAt)
  const observed = observedCurves(samples, now)
  if (observed.length === 0) return fromTranscripts ?? linearCurve()
  const fromReadings = average(observed)
  if (!fromTranscripts || observed.length >= OBSERVED_WEEKS_TO_TRUST) return fromReadings
  const w = observed.length / OBSERVED_WEEKS_TO_TRUST
  return fromReadings.map((v, h) => w * v + (1 - w) * (fromTranscripts[h] ?? 0))
}

const at = (curve: Curve, hours: number): number => {
  const h = Math.min(Math.max(hours, 0), WEEK_HOURS)
  const low = Math.floor(h)
  const high = Math.min(low + 1, WEEK_HOURS)
  const below = curve[low] ?? 0
  return below + (h - low) * ((curve[high] ?? below) - below)
}

/**
 * Green up to 10% over target, yellow up to 25% over, red past that.
 * Early in the week the target is tiny, so the bands never shrink below 2 and 5 points.
 */
export const lightFor = (used: number, target: number): Light => {
  if (used <= Math.max(target * 1.1, target + 2)) return 'green'
  if (used <= Math.max(target * 1.25, target + 5)) return 'yellow'
  return 'red'
}

export const pace = (used: number, curve: Curve, resetsAt: number, now: number): Pace => {
  const share = at(curve, (now - (resetsAt - WEEK_MS)) / HOUR_MS)
  const target = share * 100
  // Below 5% of the usual week a projection is noise.
  const projected = share >= 0.05 ? used / share : null
  return { target, light: lightFor(used, target), projected }
}
