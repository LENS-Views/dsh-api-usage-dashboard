/**
 * dsh-api-usage-dashboard — host half.
 *
 * Aggregates model-API usage (requests, input/output tokens) per provider and
 * model across every Session in the corpus, and serves it over one loopback
 * JSON route that the browser half renders as a dashboard page.
 *
 * Data comes from the framework session store (`ctx.sessionQuery`): the
 * `assistant/message` usage records are the durable truth for what this
 * Harness actually sent to each provider. No provider credential is read and
 * no external request is made.
 */

/** Stable cordis plugin name (also the client bundle mount id). */
export const name = 'dsh-api-usage-dashboard'

/** Services required before the route can answer. */
export const inject = ['webServer']

/** Route path shared with the browser half (spelled here, not imported). */
export const API = { summary: '/api/dsh-api-usage/summary' }

const CONFIG_FIELDS = {
  cacheTtlMs: 'number',
  maxSessions: 'number',
  scanConcurrency: 'number',
}

const CONFIG_DEFAULTS = {
  cacheTtlMs: 20000,
  maxSessions: 0,
  scanConcurrency: 4,
}

/**
 * Config schema exposed to the cordis loader: a hand-built Standard Schema
 * (version 1) so the host half needs no external package, matching how the
 * loader validates a row's `config`.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-api-usage-dashboard',
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (typeof value !== 'object') {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      const out = {}
      for (const [key, type] of Object.entries(CONFIG_FIELDS)) {
        const raw = value[key]
        const fallback = CONFIG_DEFAULTS[key]
        if (raw === undefined || raw === null) {
          out[key] = fallback
          continue
        }
        if (type === 'number' && typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
          out[key] = raw
        } else {
          out[key] = fallback
        }
      }
      return { value: out }
    },
  },
  shape: CONFIG_FIELDS,
  defaults: CONFIG_DEFAULTS,
}

function resolveConfig(raw) {
  const value = raw ?? {}
  const pick = (key, min) => {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= min) return candidate
    return CONFIG_DEFAULTS[key]
  }
  return {
    cacheTtlMs: pick('cacheTtlMs', 0),
    maxSessions: pick('maxSessions', 0),
    scanConcurrency: Math.max(1, Math.min(8, pick('scanConcurrency', 1))),
  }
}

/** Write a JSON response with a status code. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Whether the request comes from the loopback interface. */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === '127.0.0.1' ||
    address === 'localhost' ||
    address.startsWith('::ffff:127.')
  )
}

function guard(req, res, method) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  if ((req.method ?? 'GET') !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
    return false
  }
  return true
}

/** Local midnight `daysAgo` days before today (calendar arithmetic, DST-safe). */
function dayStartOffset(daysAgo) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime()
}

/** Calendar day key in the host's local time. */
function dayKeyOf(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function hourKey(hour) {
  return String(hour).padStart(2, '0')
}

const RANGE_DAYS = { today: 0, '7d': 6, '30d': 29 }
const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a `YYYY-MM-DD` local calendar day into its midnight, or undefined. */
function parseDayKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (match === null) return undefined
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  if (!Number.isFinite(time)) return undefined
  // Rejects impossible dates the Date constructor silently rolls over (02-31).
  return dayKeyOf(time) === key ? time : undefined
}

/**
 * Resolve one request's time window. An explicit `day` is one 24-hour day
 * charted by hour; the rest of the ranges are charted by calendar day.
 */
function resolveWindow(range, day) {
  if (day !== null) {
    const from = parseDayKey(day)
    if (from === undefined) return { error: `unknown day: ${day}` }
    return { range: 'day', granularity: 'hour', from, to: from + DAY_MS, day }
  }
  if (range === 'today') {
    return { range, granularity: 'hour', from: dayStartOffset(0), to: Date.now(), day: dayKeyOf(Date.now()) }
  }
  if (range === 'all') {
    return { range, granularity: 'day', from: 0, to: Date.now(), day: null }
  }
  if (!(range in RANGE_DAYS)) return { error: `unknown range: ${range}` }
  return { range, granularity: 'day', from: dayStartOffset(RANGE_DAYS[range]), to: Date.now(), day: null }
}

/** Numbers from a possibly partial usage record. */
function usageOf(usage) {
  const input = Number(usage?.inputTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const cacheRead = Number(usage?.cacheReadTokens) || 0
  const cacheWrite = Number(usage?.cacheWriteTokens) || 0
  const total = Number(usage?.totalTokens) || input + output + cacheRead + cacheWrite
  return { input, output, cacheRead, cacheWrite, total }
}

const AUX_EVENTS = new Set(['session/title-llm-request', 'web/deepseek-search-llm-request'])

/**
 * Fold one Session's raw event log into usage samples.
 *
 * `assistant/message` carries the settled token usage of one model call along
 * with that call's provider/model identity; `request/header` supplies the
 * identity for logs whose message source omits it; `compaction/summary` is a
 * real model call recorded outside a Turn.
 */
function extractSamples(snapshot) {
  const samples = []
  let provider
  let model
  for (const event of snapshot.events) {
    const type = event.type
    if (type === 'request/header') {
      const config = event.data?.header?.config
      if (config?.provider) provider = config.provider
      if (config?.model) model = config.model
    } else if (type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage === undefined) continue
      const source = event.data?.message?.source
      samples.push({
        time: event.time,
        kind: 'chat',
        provider: source?.provider ?? provider ?? 'unknown',
        model: source?.model ?? model ?? 'unknown',
        ...usageOf(usage),
      })
    } else if (type === 'compaction/summary') {
      const usage = event.data?.usage
      if (usage === undefined) continue
      samples.push({
        time: event.time,
        kind: 'compaction',
        provider: provider ?? 'unknown',
        model: event.data?.model ?? model ?? 'unknown',
        ...usageOf(usage),
      })
    } else if (AUX_EVENTS.has(type)) {
      // Title generation and web search are provider calls too, but the log
      // records no usage for them: they count as requests only.
      samples.push({ time: event.time, kind: 'aux' })
    }
  }
  return samples
}

/** Bounded-concurrency map that never rejects. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Aggregate per-provider, per-model and per-bucket totals from stored samples. */
function buildSummary(samples, meta, window) {
  const { granularity, from, day } = window
  const end = granularity === 'hour' && day !== null ? from + DAY_MS : Infinity
  const inWindow = (time) => time >= from && time < end
  const providers = new Map()
  const days = new Map()
  const hours = []
  const totals = { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0 }
  const availableDays = new Map()
  let aux = 0

  for (let hour = 0; hour < 24; hour += 1) {
    hours.push({ key: hourKey(hour), hour, requests: 0, input: 0, cacheRead: 0, output: 0, total: 0 })
  }

  for (const sample of samples) {
    if (sample.kind === 'aux') {
      if (inWindow(sample.time)) aux += 1
      continue
    }
    // Day inventory for the picker: the whole corpus, not the current window.
    const inventoryKey = dayKeyOf(sample.time)
    let inventoryDay = availableDays.get(inventoryKey)
    if (inventoryDay === undefined) {
      inventoryDay = { key: inventoryKey, requests: 0, total: 0 }
      availableDays.set(inventoryKey, inventoryDay)
    }
    inventoryDay.requests += 1
    inventoryDay.total += sample.total

    if (!inWindow(sample.time)) continue

    totals.requests += 1
    totals.input += sample.input
    totals.output += sample.output
    totals.total += sample.total
    totals.cacheRead += sample.cacheRead

    let provider = providers.get(sample.provider)
    if (provider === undefined) {
      provider = { provider: sample.provider, requests: 0, input: 0, cacheRead: 0, output: 0, total: 0, lastUsedAt: 0, models: new Map() }
      providers.set(sample.provider, provider)
    }
    provider.requests += 1
    provider.input += sample.input
    provider.cacheRead += sample.cacheRead
    provider.output += sample.output
    provider.total += sample.total
    if (sample.time > provider.lastUsedAt) provider.lastUsedAt = sample.time

    let model = provider.models.get(sample.model)
    if (model === undefined) {
      model = { model: sample.model, requests: 0, input: 0, cacheRead: 0, output: 0, total: 0, lastUsedAt: 0, hourly: null }
      provider.models.set(sample.model, model)
    }
    model.requests += 1
    model.input += sample.input
    model.cacheRead += sample.cacheRead
    model.output += sample.output
    model.total += sample.total
    if (sample.time > model.lastUsedAt) model.lastUsedAt = sample.time

    const key = dayKeyOf(sample.time)
    let dayBucket = days.get(key)
    if (dayBucket === undefined) {
      dayBucket = { key, date: key, requests: 0, input: 0, cacheRead: 0, output: 0, total: 0 }
      days.set(key, dayBucket)
    }
    dayBucket.requests += 1
    dayBucket.input += sample.input
    dayBucket.cacheRead += sample.cacheRead
    dayBucket.output += sample.output
    dayBucket.total += sample.total

    if (granularity === 'hour') {
      const hour = new Date(sample.time).getHours()
      const slot = hours[hour]
      slot.requests += 1
      slot.input += sample.input
      slot.cacheRead += sample.cacheRead
      slot.output += sample.output
      slot.total += sample.total
      if (model.hourly === null) model.hourly = new Array(24).fill(null).map(() => ({ requests: 0, total: 0 }))
      model.hourly[hour].requests += 1
      model.hourly[hour].total += sample.total
    }
  }

  const providerList = [...providers.values()]
    .map((entry) => ({
      ...entry,
      models: [...entry.models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider))

  // Per-model hourly series for the selected day (the official per-model
  // charts), flattened so the client needs no provider grouping.
  const modelSeries = granularity !== 'hour' ? [] : providerList.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.provider,
      model: model.model,
      requests: model.requests,
      total: model.total,
      hourly: model.hourly ?? new Array(24).fill(null).map(() => ({ requests: 0, total: 0 })),
    })))

  // Chart buckets. Hourly is always a full 24-hour day; daily is every day of
  // a bounded range, or the days that carry data when the range is "all".
  let buckets = []
  if (granularity === 'hour') {
    buckets = hours
  } else if (from !== 0) {
    for (let time = from; time < end; ) {
      const key = dayKeyOf(time)
      buckets.push(days.get(key) ?? { key, date: key, requests: 0, input: 0, cacheRead: 0, output: 0, total: 0 })
      if (time >= dayStartOffset(0)) break
      const next = new Date(time)
      time = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1).getTime()
    }
  } else {
    buckets = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
  }

  return {
    range: window.range,
    granularity,
    day: window.day,
    from: from === 0 ? null : from,
    to: window.to,
    totals,
    providers: providerList.map((entry) => ({
      ...entry,
      models: entry.models.map((model) => ({
        model: model.model,
        requests: model.requests,
        input: model.input,
        cacheRead: model.cacheRead,
        output: model.output,
        total: model.total,
        lastUsedAt: model.lastUsedAt,
      })),
    })),
    modelSeries,
    buckets,
    // Kept for clients built before the hourly split.
    daily: buckets,
    availableDays: [...availableDays.values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 60),
    auxRequests: aux,
    sessions: meta,
  }
}

/** Cache of every session's parsed samples, refreshed as a whole. */
function createCollector(ctx, config) {
  let cache = null
  let pending = null

  const scan = async () => {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      throw new Error('sessionQuery service is unavailable in this profile')
    }
    const records = await sessionQuery.listSessions()
    const selected = config.maxSessions > 0 && records.length > config.maxSessions
      ? records.slice(0, config.maxSessions)
      : records

    const samples = []
    let skipped = 0
    await mapLimited(selected, config.scanConcurrency, async (record) => {
      let snapshot
      try {
        snapshot = await sessionQuery.readSession(record.header.id)
      } catch {
        skipped += 1
        return
      }
      try {
        for (const sample of extractSamples(snapshot)) samples.push(sample)
      } catch {
        skipped += 1
      }
    })
    return {
      samples,
      meta: { total: records.length, scanned: selected.length - skipped, skipped },
    }
  }

  const collect = async () => {
    if (cache !== null && Date.now() - cache.at < config.cacheTtlMs) return cache
    if (pending !== null) return pending
    pending = (async () => {
      try {
        const scanned = await scan()
        cache = { at: Date.now(), ...scanned }
        return cache
      } finally {
        pending = null
      }
    })()
    return pending
  }

  return { collect }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const collector = createCollector(ctx, resolved)

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: API.summary,
    handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      let url
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        writeJson(res, 400, { ok: false, error: 'malformed request url' })
        return
      }
      const range = url.searchParams.get('range') ?? '7d'
      const dayParam = url.searchParams.get('day')
      const day = dayParam === null || dayParam === '' ? null : dayParam
      const window = resolveWindow(range, day)
      if (window.error !== undefined) {
        writeJson(res, 400, { ok: false, error: window.error })
        return
      }
      try {
        const scanned = await collector.collect()
        const summary = buildSummary(scanned.samples, scanned.meta, window)
        writeJson(res, 200, { ok: true, generatedAt: Date.now(), ...summary })
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  ctx.effect(() => () => dispose(), 'dsh-api-usage-dashboard: route')
}
