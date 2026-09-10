import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// The plugin's entry is the built bundle (package.json main). Importing './index.js'
// from test/ pointed at a file that never existed, so this test could not load at all.
import * as m from '../dist/index.js'

const registered = []
m.apply({ tools: { register: (t) => registered.push(t) } })
const scan = registered.find((t) => t.name === 'session_repair_scan')
const fix = registered.find((t) => t.name === 'session_repair_fix')

// Platform-neutral scratch space: the old hardcoded /tmp path resolved to C:\tmp on
// Windows and needed the drive root to be writable.
const base = join(tmpdir(), 'srtest', 'sessions')
// Start from a clean fixture: zstd refuses to overwrite an existing -o target, so a
// second consecutive run used to fail with "already exists" on a leftover file.
rmSync(join(tmpdir(), 'srtest'), { recursive: true, force: true })
mkdirSync(base, { recursive: true })
const d1 = base + '/--home-x--/session-abc'
mkdirSync(d1, { recursive: true })
const header = JSON.stringify({ type: 'session', version: 0, id: 'session-abc', createdAt: 1, cwd: '/x' })
const ev = JSON.stringify({ type: 'llm/failover', seq: 1, data: { from: 'a', to: 'b' } })
const raw = [header, ev, JSON.stringify({ type: 'message', seq: 2 })].join('\n') + '\n'
const rawFile = join(tmpdir(), 'srtest', 'raw.txt')
mkdirSync(join(tmpdir(), 'srtest'), { recursive: true })
writeFileSync(rawFile, raw)
execFileSync('zstd', ['-f', '-c', '-q', rawFile, '-o', d1 + '/session.jsonl.zstd'])

const d2 = base + '/--home-x--/session-def'
mkdirSync(d2, { recursive: true })
const parts = [header, ev].map((l) => execFileSync('zstd', ['-c', '-q'], { input: l + '\n' }))
writeFileSync(d2 + '/session.jsonl.zstd', Buffer.concat(parts))

const scanRep = await scan.execute({ sessionsDir: base }, {})
console.log('SCAN:'); console.log(JSON.stringify(scanRep, null, 1))

const fixRep = await fix.execute({ sessionsDir: base }, {})
console.log('FIX:'); console.log(JSON.stringify(fixRep, null, 1))

const scanRep2 = await scan.execute({ sessionsDir: base }, {})
console.log('RESCAN:', JSON.stringify(scanRep2.files.map((f) => [f.path.split('/').pop(), f.issues])))

const first = execFileSync('zstd', ['-d', '-c', '-q', d1 + '/session.jsonl.zstd'], { encoding: 'utf-8' })
console.log('D1 line1:', first.split('\n')[0].slice(0, 60))
console.log('D1 has ignorable:', first.includes('ignorable'))