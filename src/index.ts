/**
 * dsh-session-repair — scans and repairs DSH session logs.
 *
 * Fixes two failure modes seen in the wild:
 *   1. corrupt Zstandard session log: a session.jsonl.zstd re-compressed as a
 *      single zstd frame (error: first frame is not exactly one header line).
 *   2. SessionFormatUnsupportedError: events whose type the running harness
 *      does not know and that are not marked "ignorable": true.
 *
 * Requires the `zstd` CLI on PATH (standard on Debian/Ubuntu servers;
 * also available for macOS and Windows). Every repaired file is backed up
 * as <file>.bak-repair-<timestamp> before replacement.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

export const name = 'session-repair'
export const inject = ['tools']

const execFileP = promisify(execFile)

type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

interface Tool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[] }
  output: {
    schema: Json
    render: (args: Json, value: Json) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  presentCall?: (args: Json) => Json
  execute: (args: Json, exec: { signal?: AbortSignal }) => Promise<Json>
}

interface Ctx {
  tools: { register: (tool: Tool) => void }
}

/**
 * Event types known to current harnesses (collected from real sessions).
 * Types absent from this set (e.g. llm/failover, written by newer builds)
 * are the ones that make older harnesses refuse the whole log.
 */
const KNOWN_TYPES = new Set([
  'session', 'message', 'user/message', 'assistant/message', 'assistant/chunk',
  'text', 'text-chunks', 'text-delta', 'reasoning', 'reasoning-chunks', 'reasoning-delta',
  'block-start', 'block-end', 'tool-call', 'tool-call-chunks', 'tool-call-delta',
  'tool-result', 'tool/call', 'tool/result', 'tool/code-dispatch', 'tool/code-dispatch-start',
  'finish', 'usage', 'step/start', 'step/end', 'turn/start', 'turn/end',
  'agent/inbox/spliced', 'todo/write', 'request/header', 'request/context',
  'session/title', 'session/end-seed', 'session/title-llm-request',
  'compaction/summary', 'compaction/start', 'compaction/end', 'sandbox/mode',
  'string', 'object'
])

const sessionsRoot = () =>
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(homedir(), '.dsh', 'sessions')

async function listSessionLogs(root: string): Promise<string[]> {
  const out: string[] = []
  // One session = one directory, and DSH migrates a log to a new generation
  // (session.v<N>.jsonl.zstd) while keeping the older file beside it. Repair must
  // target the generation the harness actually READS - fixing a stale v0 log while
  // v3 is live is a silent no-op that reports success.
  const best = new Map<string, { v: number; path: string }>()
  const walk = async (dir: string) => {
    let ents
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(e.name)
      if (m === null) continue
      const v = m[1] === undefined ? 0 : Number(m[1])
      const prev = best.get(dir)
      if (prev === undefined || v > prev.v) best.set(dir, { v, path: p })
    }
  }
  await walk(root)
  for (const entry of best.values()) out.push(entry.path)
  return out
}

async function zstdFrames(p: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('zstd', ['-l', p], { maxBuffer: 1 << 20 })
    const m = stdout.match(/^\s*(\d+)\s/m)
    return m ? parseInt(m[1], 10) : null
  } catch { return null }
}

async function zstdDecompress(p: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('zstd', ['-d', '-c', '-q', p], { maxBuffer: 512 << 20 })
    return stdout
  } catch { return null }
}

function zstdFrame(line: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('zstd', ['-c', '-q'])
    const out: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('zstd exit ' + code))))
    p.stdin.end(line + '\n')
  })
}

interface LineInfo { type?: string; ignorable?: boolean; seq?: number; parseOk: boolean }

function parseLine(s: string): LineInfo {
  const info: LineInfo = { parseOk: true }
  try {
    const o = JSON.parse(s) as Record<string, Json>
    if (o && typeof o === 'object') {
      info.type = typeof o.type === 'string' ? o.type : undefined
      info.ignorable = o.ignorable === true
      info.seq = typeof o.seq === 'number' ? o.seq : undefined
    }
  } catch { info.parseOk = false }
  return info
}

interface InspectResult {
  path: string
  sessionId: string | null
  frames: number | null
  lines: number
  headerOk: boolean
  issues: string[]
  unknownEvents: { seq: number | null; type: string }[]
  parseErrors: number[]
}

async function inspect(p: string): Promise<InspectResult> {
  const res: InspectResult = {
    path: p, sessionId: null, frames: null, lines: 0, headerOk: false,
    issues: [], unknownEvents: [], parseErrors: [],
  }
  res.frames = await zstdFrames(p)
  const text = await zstdDecompress(p)
  if (text === null) { res.issues.push('UNDECODABLE'); return res }
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  res.lines = lines.length
  if (lines.length === 0) { res.issues.push('EMPTY'); return res }
  const first = parseLine(lines[0])
  res.headerOk = first.parseOk && first.type === 'session'
  if (!res.headerOk) res.issues.push('BAD_HEADER')
  if (res.frames === 1 && res.lines > 1) res.issues.push('SINGLE_FRAME_CORRUPT')
  lines.forEach((l, i) => {
    const info = parseLine(l)
    if (!info.parseOk) { res.parseErrors.push(i + 1); return }
    if (info.type && info.type !== 'session' && !KNOWN_TYPES.has(info.type) && !info.ignorable) {
      res.unknownEvents.push({ seq: info.seq ?? null, type: info.type })
    }
  })
  if (res.parseErrors.length) res.issues.push('PARSE_ERRORS')
  if (res.unknownEvents.length) res.issues.push('UNKNOWN_EVENTS')
  const m = lines[0].match(/"id"\s*:\s*"([^"]+)"/)
  if (m) res.sessionId = m[1]
  return res
}

async function rebuildFrames(p: string, lines: string[]): Promise<string> {
  const chunks: Buffer[] = new Array(lines.length)
  let next = 0
  const workers = Array.from({ length: Math.min(8, lines.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= lines.length) return
      chunks[i] = await zstdFrame(lines[i])
    }
  })
  await Promise.all(workers)
  const tmp = p + '.repair-tmp'
  const fs = await import('node:fs/promises')
  const fd = await fs.open(tmp, 'w')
  for (const c of chunks) await fd.write(c)
  await fd.close()
  return tmp
}

async function repair(p: string, extraKnown: string[]): Promise<{ backup: string; frames: number; marked: number }> {
  const known = new Set([...KNOWN_TYPES, ...extraKnown])
  const text = await zstdDecompress(p)
  if (text === null) throw new Error('undecodable: ' + p)
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  let marked = 0
  const fixed = lines.map((l) => {
    const info = parseLine(l)
    if (!info.parseOk) return l
    if (info.type && info.type !== 'session' && !known.has(info.type) && !info.ignorable) {
      const o = JSON.parse(l) as Record<string, Json>
      o.ignorable = true
      marked++
      return JSON.stringify(o)
    }
    return l
  })
  const backup = p + '.bak-repair-' + new Date().toISOString().replace(/[:.]/g, '-')
  await copyFile(p, backup)
  const tmp = await rebuildFrames(p, fixed)
  const frames = await zstdFrames(tmp)
  if (frames === null || frames !== fixed.length) {
    throw new Error('rebuild verification failed (frames=' + frames + ' lines=' + fixed.length + ')')
  }
  await rename(tmp, p)
  return { backup, frames, marked }
}

function renderText(value: Json) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Ctx) {
  ctx.tools.register({
    name: 'session_repair_scan',
    description: 
      'Scan DSH session logs (~/.dsh/sessions) for corruption and unknown-event problems. ' +
      'Read-only: reports frames vs lines, bad headers, unparseable lines, and unknown event ' +
      'types missing the ignorable flag. Use session_repair_fix to repair.',
    parameters: {
      type: 'object',
      properties: {
        sessionsDir: { type: 'string', description: 'Override the sessions directory (default ~/.dsh/sessions)' },
      },
      required: [],
    },
    output: {
      // The host validates tool schemas at register() and aborts the WHOLE plugin tree when
      // one is invalid: an object schema must state additionalProperties explicitly.
      schema: { type: 'object', additionalProperties: true },
      render: renderText,
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args: Json) => {
      const dir = (args as { sessionsDir?: string }).sessionsDir || sessionsRoot()
      const files = await listSessionLogs(dir)
      const results = []
      for (const f of files) results.push(await inspect(f))
      return JSON.parse(JSON.stringify({ sessionsDir: dir, scanned: files.length, files: results }))
    },
  })
  ctx.tools.register({
    name: 'session_repair_fix',
    description: 
      'Repair DSH session logs: rebuild single-frame corrupt files into the multi-frame ' +
      'one-line-per-frame layout and mark unknown event types as ignorable. ' +
      'Every touched file is backed up as <file>.bak-repair-<timestamp>. ' +
      'Restart the harness afterwards so it reloads the sessions.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Only repair this session id (default: all problem sessions)' },
        sessionsDir: { type: 'string', description: 'Override the sessions directory (default ~/.dsh/sessions)' },
        extraKnownTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra event types this harness knows; they will not be marked ignorable',
        },
      },
      required: [],
    },
    output: {
      // The host validates tool schemas at register() and aborts the WHOLE plugin tree when
      // one is invalid: an object schema must state additionalProperties explicitly.
      schema: { type: 'object', additionalProperties: true },
      render: renderText,
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    execute: async (args: Json) => {
      const a = args as { sessionId?: string; sessionsDir?: string; extraKnownTypes?: string[] }
      const dir = a.sessionsDir || sessionsRoot()
      const extra = a.extraKnownTypes || []
      const files = await listSessionLogs(dir)
      const repaired = []
      const skipped = []
      for (const f of files) {
        const st = await inspect(f)
        const wanted = !a.sessionId || st.sessionId === a.sessionId
        if (!wanted || st.issues.length === 0) {
          if (wanted) skipped.push({ path: f, sessionId: st.sessionId, issues: st.issues })
          continue
        }
        const r = await repair(f, extra)
        repaired.push({ path: f, sessionId: st.sessionId, issues: st.issues, backup: r.backup, frames: r.frames, markedUnknown: r.marked })
      }
      return JSON.parse(JSON.stringify({
        sessionsDir: dir,
        repaired,
        skipped,
        note: 'Restart the harness (systemctl restart dsh-web) to reload repaired sessions.',
      }))
    },
  })
}