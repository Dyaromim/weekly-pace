// Keeps the seven_day quota reading and the usual-week profile, and draws the pacing band above the prompt.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { HourlyUsage, PaceModel, QuotaReading, QuotaSample } from '../types'
import { HOUR_MS, WEEK_MS, pace, usualCurve } from './pace'
import type { Light } from './pace'

const READING = { plugin: 'weekly-pace', key: 'reading' } as const
const MODEL = { plugin: 'weekly-pace', key: 'model' } as const
const NOW = { plugin: 'weekly-pace', key: 'now' } as const

const PROFILE_DAYS = '91'
const PROFILE_MAX_AGE_MS = 24 * HOUR_MS
const SAMPLE_EVERY_MS = 30 * 60_000
const SAMPLES_KEPT_MS = 16 * WEEK_MS
const TICK_MS = 10 * 60_000

const LIGHTS: Record<Light, { dot: string; color: string }> = {
  green: { dot: '🟢', color: 'success' },
  yellow: { dot: '🟡', color: 'warning' },
  red: { dot: '🔴', color: 'error' },
}

const LABELS = {
  title: 'מכסה שבועית',
  target: 'יעד',
  projected: 'צפי',
  resetsIn: 'איפוס בעוד',
  days: 'י׳',
  hours: 'ש׳',
  waiting: 'מכסה שבועית: ממתין לקריאה ראשונה מהשרת',
}

const sevenDay = (limits: SessionRateLimit[]): QuotaReading | null => {
  const window = limits.find(l => l.kind === 'seven_day')
  const resetsAt = window?.resetsAt ? Date.parse(window.resetsAt) : NaN
  return window && Number.isFinite(resetsAt) ? { percentUsed: window.percentUsed, resetsAt } : null
}

const loadModel = async ($: EngineInterface): Promise<PaceModel> => ({
  hourly: ((await $.store.get('hourly')) ?? {}) as HourlyUsage,
  builtAt: Number((await $.store.get('builtAt')) ?? 0),
  samples: ((await $.store.get('samples')) ?? []) as QuotaSample[],
})

/** Scans the transcripts in a child process: they are far larger than the sandbox may read. */
const rebuildProfile = async ($: EngineInterface) => {
  const script = `${$.plugin.root}/scripts/build-profile.mjs`
  const { exitCode, stdout, stderr } = await $.process.run(['node', script, PROFILE_DAYS], {
    timeoutMs: 600_000,
  })
  if (exitCode !== 0) {
    $.ui.log(`weekly-pace: profile build failed: ${stderr.slice(0, 300)}`)
    return
  }
  const { hours } = JSON.parse(stdout) as { hours: HourlyUsage }
  const builtAt = await $.clock.now()
  await $.store.set('hourly', hours)
  await $.store.set('builtAt', builtAt)
  const { value: current } = await $.state.get(MODEL)
  await $.state.set(MODEL, { samples: current?.samples ?? [], hourly: hours, builtAt })
}

const recordSample = async ($: EngineInterface, quota: QuotaReading) => {
  const t = await $.clock.now()
  const samples = ((await $.store.get('samples')) ?? []) as QuotaSample[]
  const last = samples[samples.length - 1]
  const isFresh = last && last.resetsAt === quota.resetsAt && t - last.t < SAMPLE_EVERY_MS
  if (isFresh && last.pct === quota.percentUsed) return
  const kept = samples.filter(s => t - s.t < SAMPLES_KEPT_MS)
  // Within the throttle window the newer reading replaces the older one.
  if (isFresh) kept.pop()
  kept.push({ t, pct: quota.percentUsed, resetsAt: quota.resetsAt })
  await $.store.set('samples', kept)
  const { value: current } = await $.state.get(MODEL)
  if (current) await $.state.set(MODEL, { ...current, samples: kept })
}

const setReading = async ($: EngineInterface, limits: SessionRateLimit[]) => {
  const quota = sevenDay(limits)
  if (!quota) return
  await $.state.set(READING, quota)
  await $.state.set(NOW, await $.clock.now())
  await recordSample($, quota)
}

const bar = (used: number, target: number, width: number) => {
  const cell = (pct: number) => Math.min(Math.round((pct / 100) * width), width)
  const filled = cell(used)
  const mark = Math.min(cell(target), width - 1)
  return Array.from({ length: width }, (_, i) =>
    i === mark ? '│' : i < filled ? '█' : '░',
  ).join('')
}

const resetsIn = (resetsAt: number, t: number) => {
  const hours = Math.max(Math.round((resetsAt - t) / HOUR_MS), 0)
  const days = Math.floor(hours / 24)
  return `${LABELS.resetsIn} ${days > 0 ? `${days}${LABELS.days} ` : ''}${hours % 24}${LABELS.hours}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const loaded = await loadModel($)
    await $.state.set(MODEL, loaded)
    await $.state.set(NOW, await $.clock.now())
    await setReading($, (await $.session.usage()).rateLimits)

    $.clock.every(TICK_MS, () => void $.clock.now().then(t => $.state.set(NOW, t)))
    if ((await $.clock.now()) - loaded.builtAt > PROFILE_MAX_AGE_MS) {
      // Off the start path: the scan takes a minute or two.
      $.clock.after(5_000, () => void rebuildProfile($))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await setReading($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { value: quota } = await $.state.get(READING)
    if (!quota) return <Text dimColor>{LABELS.waiting}</Text>

    const { value: t = 0 } = await $.state.get(NOW)
    const { value: m } = await $.state.get(MODEL)
    const curve = usualCurve(m?.hourly ?? {}, m?.samples ?? [], quota.resetsAt, t)
    const { target, light, projected } = pace(quota.percentUsed, curve, quota.resetsAt, t)
    const width = Math.max(Math.min(e.props.bodyColumns - 60, 40), 10)

    return (
      <Box flexDirection="row" gap={1}>
        <Text>{LIGHTS[light].dot}</Text>
        <Text dimColor>{LABELS.title}</Text>
        <Text color={LIGHTS[light].color}>{bar(quota.percentUsed, target, width)}</Text>
        <Text bold>{Math.round(quota.percentUsed)}%</Text>
        <Text dimColor>
          {LABELS.target} {Math.round(target)}%
          {projected === null ? '' : ` · ${LABELS.projected} ${Math.round(projected)}%`}
          {` · ${resetsIn(quota.resetsAt, t)}`}
        </Text>
      </Box>
    )
  })
}
