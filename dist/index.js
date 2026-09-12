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
  const best = /* @__PURE__ */ new Map();
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
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(e.name);
      if (m === null) continue;
      const v = m[1] === void 0 ? 0 : Number(m[1]);
      const prev = best.get(dir);
      if (prev === void 0 || v > prev.v) best.set(dir, { v, path: p });
    }
  };
  await walk(root);
  for (const entry of best.values()) out.push(entry.path);
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
function classifyDecodeFailure(err) {
  const e = err;
  if (e?.code === "ENOENT") return "no-zstd-cli";
  const text = String(e?.stderr ?? "") + " " + String(e?.message ?? "");
  if (/allocation error|not enough memory|ZSTD_error_memory_allocation/i.test(text)) return "out-of-memory";
  if (/not a zstandard|unsupported|corrupt|unknown frame|premature|unsupported frame/i.test(text)) return "format";
  return "unknown";
}
async function zstdDecompress(p) {
  try {
    const { stdout } = await execFileP("zstd", ["-d", "-c", "-q", p], { maxBuffer: 512 << 20 });
    return { text: stdout, failure: null, detail: "" };
  } catch (err) {
    const e = err;
    return {
      text: null,
      failure: classifyDecodeFailure(err),
      detail: String(e?.stderr ?? e?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
    };
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
    advisories: [],
    problem: false,
    unknownEvents: [],
    parseErrors: []
  };
  res.frames = await zstdFrames(p);
  const dec = await zstdDecompress(p);
  if (dec.text === null) {
    res.decodeFailure = dec.failure;
    res.decodeDetail = dec.detail;
    res.issues.push(dec.failure === "out-of-memory" ? "DECODE_OUT_OF_MEMORY" : dec.failure === "no-zstd-cli" ? "ZSTD_CLI_MISSING" : "UNDECODABLE");
    res.advisories.push(dec.failure === "out-of-memory" ? "decoder ran out of memory (ZSTD_error_memory_allocation) \u2014 retry later or free memory; the file itself is fine" : dec.failure === "no-zstd-cli" ? "the zstd CLI is not on PATH \u2014 install it to inspect, not to repair" : "decoder rejected the stream \u2014 verify with an independent decoder before treating this as corruption");
    res.problem = dec.failure === "format";
    return res;
  }
  const text = dec.text;
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
  if (res.unknownEvents.length) {
    res.advisories.push(res.unknownEvents.length + " event type(s) newer than this scanner's vocabulary; harmless, no repair needed");
  }
  res.problem = res.issues.length > 0;
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
  const dec = await zstdDecompress(p);
  if (dec.text === null) {
    throw new Error("refusing to rewrite " + p + ': decoder failure is "' + dec.failure + '" (' + (dec.detail || "no detail") + "), which is not corruption. Free memory / install the zstd CLI and rescan.");
  }
  const lines = dec.text.split("\n").filter((l) => l.trim().length > 0);
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
    description: "Scan DSH session logs (~/.dsh/sessions) for real corruption. Read-only. Splits findings into problems (bad header, single-frame layout, unparseable lines, decoder failure classified as FORMAT) and advisories (newer event vocabulary, out-of-memory or missing-decoder failures) \u2014 advisories need NO action. Only repair when problems > 0. Returns a compact summary by default; pass verbose:true for the per-file detail.",
    parameters: {
      type: "object",
      properties: {
        sessionsDir: { type: "string", description: "Override the sessions directory (default ~/.dsh/sessions)" },
        verbose: { type: "boolean", description: "Full per-file report (large). Default is a compact summary." }
      },
      required: []
    },
    output: {
      // The host validates tool schemas at register() and aborts the WHOLE plugin tree when
      // one is invalid: an object schema must state additionalProperties explicitly.
      schema: { type: "object", additionalProperties: true },
      render: renderText
    },
    timeoutMs: 12e4,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = args.sessionsDir || sessionsRoot();
      const files = await listSessionLogs(dir);
      const results = [];
      for (const f of files) results.push(await inspect(f));
      const problems = results.filter((r) => r.problem);
      const withAdvisory = results.filter((r) => !r.problem && r.advisories.length);
      const base = {
        sessionsDir: dir,
        scanned: files.length,
        // Only `problems` need action. `advisories` (newer event vocabulary, resource failures) are informational.
        problems: problems.length,
        advisories: withAdvisory.length
      };
      if (args.verbose !== true) {
        const histogram = {};
        const advisories = {};
        for (const r of results) for (const i of r.issues) histogram[i] = (histogram[i] ?? 0) + 1;
        for (const r of withAdvisory) for (const a of r.advisories) advisories[a] = (advisories[a] ?? 0) + 1;
        return JSON.parse(JSON.stringify({
          ...base,
          issueHistogram: histogram,
          advisoryKinds: advisories,
          problemFiles: problems.slice(0, 10).map((r) => ({ path: r.path, issues: r.issues })),
          truncatedProblems: Math.max(0, problems.length - 10),
          hint: "compact summary; pass verbose:true only when you need the per-file detail"
        }));
      }
      return JSON.parse(JSON.stringify({ ...base, files: results }));
    }
  });
  ctx.tools.register({
    name: "session_repair_fix",
    description: "Repair DSH session logs: rebuild single-frame corrupt files into the multi-frame one-line-per-frame layout and mark unknown event types as ignorable. Refuses files whose decoder failure was a resource problem (never treats OOM as corruption). Every touched file is backed up as <file>.bak-repair-<timestamp>. Restart the harness afterwards so it reloads the sessions.",
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
      // The host validates tool schemas at register() and aborts the WHOLE plugin tree when
      // one is invalid: an object schema must state additionalProperties explicitly.
      schema: { type: "object", additionalProperties: true },
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
  classifyDecodeFailure,
  inject,
  name
};
