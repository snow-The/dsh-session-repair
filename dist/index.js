// src/index.ts
import { execFile, spawn } from "node:child_process";
import { copyFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
var name = "session-repair";
var inject = ["tools"];
var execFileP = promisify(execFile);
var KNOWN_TYPES = /* @__PURE__ */ new Set([
  "session",
  "message",
  "user/message",
  "assistant/message",
  "assistant/chunk",
  "text",
  "text-chunks",
  "text-delta",
  "reasoning",
  "reasoning-chunks",
  "reasoning-delta",
  "block-start",
  "block-end",
  "tool-call",
  "tool-call-chunks",
  "tool-call-delta",
  "tool-result",
  "tool/call",
  "tool/result",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "finish",
  "usage",
  "step/start",
  "step/end",
  "turn/start",
  "turn/end",
  "agent/inbox/spliced",
  "todo/write",
  "request/header",
  "request/context",
  "session/title",
  "session/end-seed",
  "session/title-llm-request",
  "compaction/summary",
  "compaction/start",
  "compaction/end",
  "sandbox/mode",
  "string",
  "object"
]);
var sessionsRoot = () => process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : join(homedir(), ".dsh", "sessions");
async function listSessionLogs(root) {
  const out = [];
  const walk = async (dir) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name === "session.jsonl.zstd") out.push(p);
    }
  };
  await walk(root);
  return out;
}
async function zstdFrames(p) {
  try {
    const { stdout } = await execFileP("zstd", ["-l", p], { maxBuffer: 1 << 20 });
    const m = stdout.match(/^\s*(\d+)\s/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}
async function zstdDecompress(p) {
  try {
    const { stdout } = await execFileP("zstd", ["-d", "-c", "-q", p], { maxBuffer: 512 << 20 });
    return stdout;
  } catch {
    return null;
  }
}
function zstdFrame(line) {
  return new Promise((resolve, reject) => {
    const p = spawn("zstd", ["-c", "-q"]);
    const out = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error("zstd exit " + code)));
    p.stdin.end(line + "\n");
  });
}
function parseLine(s) {
  const info = { parseOk: true };
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") {
      info.type = typeof o.type === "string" ? o.type : void 0;
      info.ignorable = o.ignorable === true;
      info.seq = typeof o.seq === "number" ? o.seq : void 0;
    }
  } catch {
    info.parseOk = false;
  }
  return info;
}
async function inspect(p) {
  const res = {
    path: p,
    sessionId: null,
    frames: null,
    lines: 0,
    headerOk: false,
    issues: [],
    unknownEvents: [],
    parseErrors: []
  };
  res.frames = await zstdFrames(p);
  const text = await zstdDecompress(p);
  if (text === null) {
    res.issues.push("UNDECODABLE");
    return res;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  res.lines = lines.length;
  if (lines.length === 0) {
    res.issues.push("EMPTY");
    return res;
  }
  const first = parseLine(lines[0]);
  res.headerOk = first.parseOk && first.type === "session";
  if (!res.headerOk) res.issues.push("BAD_HEADER");
  if (res.frames === 1 && res.lines > 1) res.issues.push("SINGLE_FRAME_CORRUPT");
  lines.forEach((l, i) => {
    const info = parseLine(l);
    if (!info.parseOk) {
      res.parseErrors.push(i + 1);
      return;
    }
    if (info.type && info.type !== "session" && !KNOWN_TYPES.has(info.type) && !info.ignorable) {
      res.unknownEvents.push({ seq: info.seq ?? null, type: info.type });
    }
  });
  if (res.parseErrors.length) res.issues.push("PARSE_ERRORS");
  if (res.unknownEvents.length) res.issues.push("UNKNOWN_EVENTS");
  const m = lines[0].match(/"id"\s*:\s*"([^"]+)"/);
  if (m) res.sessionId = m[1];
  return res;
}
async function rebuildFrames(p, lines) {
  const chunks = new Array(lines.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(8, lines.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= lines.length) return;
      chunks[i] = await zstdFrame(lines[i]);
    }
  });
  await Promise.all(workers);
  const tmp = p + ".repair-tmp";
  const fs = await import("node:fs/promises");
  const fd = await fs.open(tmp, "w");
  for (const c of chunks) await fd.write(c);
  await fd.close();
  return tmp;
}
async function repair(p, extraKnown) {
  const known = /* @__PURE__ */ new Set([...KNOWN_TYPES, ...extraKnown]);
  const text = await zstdDecompress(p);
  if (text === null) throw new Error("undecodable: " + p);
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let marked = 0;
  const fixed = lines.map((l) => {
    const info = parseLine(l);
    if (!info.parseOk) return l;
    if (info.type && info.type !== "session" && !known.has(info.type) && !info.ignorable) {
      const o = JSON.parse(l);
      o.ignorable = true;
      marked++;
      return JSON.stringify(o);
    }
    return l;
  });
  const backup = p + ".bak-repair-" + (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  await copyFile(p, backup);
  const tmp = await rebuildFrames(p, fixed);
  const frames = await zstdFrames(tmp);
  if (frames === null || frames !== fixed.length) {
    throw new Error("rebuild verification failed (frames=" + frames + " lines=" + fixed.length + ")");
  }
  await rename(tmp, p);
  return { backup, frames, marked };
}
function renderText(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
function apply(ctx) {
  ctx.tools.register({
    name: "session_repair_scan",
    description: "Scan DSH session logs (~/.dsh/sessions) for corruption and unknown-event problems. Read-only: reports frames vs lines, bad headers, unparseable lines, and unknown event types missing the ignorable flag. Use session_repair_fix to repair.",
    parameters: {
      type: "object",
      properties: {
        sessionsDir: { type: "string", description: "Override the sessions directory (default ~/.dsh/sessions)" }
      },
      required: []
    },
    output: {
      schema: { type: "object" },
      render: renderText
    },
    timeoutMs: 12e4,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = args.sessionsDir || sessionsRoot();
      const files = await listSessionLogs(dir);
      const results = [];
      for (const f of files) results.push(await inspect(f));
      return JSON.parse(JSON.stringify({ sessionsDir: dir, scanned: files.length, files: results }));
    }
  });
  ctx.tools.register({
    name: "session_repair_fix",
    description: "Repair DSH session logs: rebuild single-frame corrupt files into the multi-frame one-line-per-frame layout and mark unknown event types as ignorable. Every touched file is backed up as <file>.bak-repair-<timestamp>. Restart the harness afterwards so it reloads the sessions.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Only repair this session id (default: all problem sessions)" },
        sessionsDir: { type: "string", description: "Override the sessions directory (default ~/.dsh/sessions)" },
        extraKnownTypes: {
          type: "array",
          items: { type: "string" },
          description: "Extra event types this harness knows; they will not be marked ignorable"
        }
      },
      required: []
    },
    output: {
      schema: { type: "object" },
      render: renderText
    },
    timeoutMs: 3e5,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const a = args;
      const dir = a.sessionsDir || sessionsRoot();
      const extra = a.extraKnownTypes || [];
      const files = await listSessionLogs(dir);
      const repaired = [];
      const skipped = [];
      for (const f of files) {
        const st = await inspect(f);
        const wanted = !a.sessionId || st.sessionId === a.sessionId;
        if (!wanted || st.issues.length === 0) {
          if (wanted) skipped.push({ path: f, sessionId: st.sessionId, issues: st.issues });
          continue;
        }
        const r = await repair(f, extra);
        repaired.push({ path: f, sessionId: st.sessionId, issues: st.issues, backup: r.backup, frames: r.frames, markedUnknown: r.marked });
      }
      return JSON.parse(JSON.stringify({
        sessionsDir: dir,
        repaired,
        skipped,
        note: "Restart the harness (systemctl restart dsh-web) to reload repaired sessions."
      }));
    }
  });
}
export {
  apply,
  inject,
  name
};
