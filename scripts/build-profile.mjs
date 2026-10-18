// Builds the weighted token usage per hour from local Claude Code transcripts.
// Runs outside the mod sandbox (transcripts total gigabytes; the sandbox reads 4 MiB per file).
// Prints JSON: { "hours": { "<epochHour>": weight, ... } }
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAYS = Number(process.argv[2] ?? 91)
const HOUR_MS = 3_600_000
const since = Date.now() - DAYS * 24 * HOUR_MS
const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

// Relative API price per million tokens. The weekly quota is shared across models,
// so an Opus token weighs more than a Haiku token. Only the ratios matter.
const PRICES = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

const priceFor = model =>
  PRICES[Object.keys(PRICES).find(family => String(model).includes(family)) ?? 'sonnet']

const weightOf = (model, usage) => {
  const price = priceFor(model)
  return (
    (usage.input_tokens ?? 0) * price.input +
    (usage.output_tokens ?? 0) * price.output +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead
  ) / 1e6
}

const transcripts = dir => {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...transcripts(path))
    else if (entry.name.endsWith('.jsonl') && statSync(path).mtimeMs >= since) found.push(path)
  }
  return found
}

const hours = {}
// A response is written once per content block, each copy carrying the same usage.
const seen = new Set()

const scan = async path => {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const message = row.message
    if (row.type !== 'assistant' || !message?.usage || !row.timestamp) continue
    if (message.id && seen.has(message.id)) continue
    if (message.id) seen.add(message.id)
    const t = Date.parse(row.timestamp)
    if (!(t >= since)) continue
    const hour = Math.floor(t / HOUR_MS)
    hours[hour] = (hours[hour] ?? 0) + weightOf(message.model, message.usage)
  }
}

for (const path of transcripts(root)) await scan(path)
for (const hour of Object.keys(hours)) hours[hour] = Math.round(hours[hour] * 1000) / 1000
process.stdout.write(JSON.stringify({ hours }))
