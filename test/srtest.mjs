import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as m from './index.js'

const registered = []
m.apply({ tools: { register: (t) => registered.push(t) } })
const scan = registered.find((t) => t.name === 'session_repair_scan')
const fix = registered.find((t) => t.name === 'session_repair_fix')

const base = '/tmp/srtest/sessions'
mkdirSync(base, { recursive: true })
const d1 = base + '/--home-x--/session-abc'
mkdirSync(d1, { recursive: true })
const header = JSON.stringify({ type: 'session', version: 0, id: 'session-abc', createdAt: 1, cwd: '/x' })
const ev = JSON.stringify({ type: 'llm/failover', seq: 1, data: { from: 'a', to: 'b' } })
const raw = [header, ev, JSON.stringify({ type: 'message', seq: 2 })].join('\n') + '\n'
writeFileSync('/tmp/srtest/raw.txt', raw)
execFileSync('zstd', ['-c', '-q', '/tmp/srtest/raw.txt', '-o', d1 + '/session.jsonl.zstd'])

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