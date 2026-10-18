/** Weighted usage per epoch hour (ms / 3_600_000), from the local transcripts. */
export type HourlyUsage = Record<string, number>

/** One observed reading of the seven_day window. */
export type QuotaSample = { t: number; pct: number; resetsAt: number }

/** The latest seven_day reading. */
export type QuotaReading = { percentUsed: number; resetsAt: number }

/** What the band draws from. */
export type PaceModel = {
  hourly: HourlyUsage
  builtAt: number
  samples: QuotaSample[]
}

declare module 'claude-code' {
  interface PluginState {
    'weekly-pace': {
      reading: QuotaReading | null
      model: PaceModel | null
      now: number
    }
  }
}
