// Copyright 2026 Yauhen Bichel
// SPDX-License-Identifier: Apache-2.0
//
// Everything that does not need VS Code: talking to the gateway, reading skills and rules, reading the
// gateway's state. extension.ts only wires these to the editor, so these parts can be tested with node --test.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  interactive: boolean;
  /** false: ask the gateway to leave its memory (the owner's notes) out of the prompt. */
  memory: boolean;
  maxTokens: number;
}

export interface Message { role: "system" | "user" | "assistant"; content: string }

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  h["authorization"] = `Bearer ${s.apiKey || "local"}`;
  if (s.interactive) h["x-yllm-priority"] = "interactive";
  if (!s.memory) h["x-yllm-memory"] = "off";
  return h;
}

// ---- skills and rules ---------------------------------------------------------------------------------

export interface Skill { name: string; description: string; body: string; file: string }

/** Front matter (key: value lines between --- fences) and the text after it. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

/** Skills from folders of <name>/SKILL.md, sorted by name; the first folder wins on a duplicate name. */
export function loadSkills(dirs: string[]): Skill[] {
  const seen = new Map<string, Skill>();
  for (const dir of dirs.map(expandHome)) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const file = path.join(dir, e, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const { meta, body } = frontMatter(fs.readFileSync(file, "utf8"));
      const name = meta.name || e;
      if (!seen.has(name)) seen.set(name, { name, description: meta.description || "", body, file });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The always-apply rules of a Continue-style rules folder, plus the ones whose globs match `file`. */
export function loadRules(dir: string, file?: string): string {
  let names: string[] = [];
  try { names = fs.readdirSync(expandHome(dir)).filter((n) => n.endsWith(".md")).sort(); } catch { return ""; }
  const parts: string[] = [];
  for (const n of names) {
    const { meta, body } = frontMatter(fs.readFileSync(path.join(expandHome(dir), n), "utf8"));
    if (meta.alwaysApply === "true" || (file && meta.globs && globsMatch(meta.globs, file))) parts.push(body);
  }
  return parts.join("\n\n");
}

export function globsMatch(globs: string, file: string): boolean {
  const list = globs.replace(/^\[|\]$/g, "").split(",").map((g) => g.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const name = file.replace(/\\/g, "/");
  return list.some((g) => {
    const re = new RegExp("^" + g.split("**/").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("(?:.*/)?") + "$");
    return re.test(name) || re.test(path.basename(name));
  });
}

export function buildMessages(opts: { rules: string; skill?: Skill; question: string; code?: string; fileName?: string; language?: string }): Message[] {
  const system = [opts.rules, opts.skill ? `Follow this skill: ${opts.skill.name}\n\n${opts.skill.body}` : ""].filter(Boolean).join("\n\n---\n\n");
  let user = opts.question;
  if (opts.code) user += `\n\nFile: ${opts.fileName ?? "(untitled)"}\n\`\`\`${opts.language ?? ""}\n${opts.code}\n\`\`\``;
  return [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: user }];
}

// ---- the gateway --------------------------------------------------------------------------------------

/** Parse one SSE buffer into data payloads; returns the payloads and the unfinished tail. */
export function parseSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const b of blocks) {
    const data = b.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

export interface StreamResult { model: string; text: string; reasoningChars: number; queueMs: number | null; seconds: number }

/** Stream a chat answer. onText gets visible text as it arrives; onThinking gets the hidden reasoning length. */
export async function streamChat(s: Settings, messages: Message[], onText: (t: string) => void,
  onThinking: (chars: number) => void, signal?: AbortSignal): Promise<StreamResult> {
  const started = Date.now();
  const res = await fetch(`${s.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST", headers: headers(s), signal,
    body: JSON.stringify({ model: s.model, messages, stream: true, max_tokens: s.maxTokens, temperature: 0.2 }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`yserver answered ${res.status}: ${body.slice(0, 300)}`);
  }
  const queue = res.headers.get("x-yllm-queue-ms");
  const out: StreamResult = { model: "", text: "", reasoningChars: 0, queueMs: queue ? Number(queue) : null, seconds: 0 };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const e of events) {
      if (e === "[DONE]") continue;
      let d: any;
      try { d = JSON.parse(e); } catch { continue; }
      out.model = d.model || out.model;
      const delta = d.choices?.[0]?.delta ?? {};
      const thinking = delta.reasoning ?? delta.reasoning_content;
      if (thinking) { out.reasoningChars += thinking.length; onThinking(out.reasoningChars); }
      if (delta.content) { out.text += delta.content; onText(delta.content); }
    }
  }
  out.seconds = (Date.now() - started) / 1000;
  return out;
}

// ---- the gateway's state ------------------------------------------------------------------------------

export interface State {
  ok: boolean;
  resident?: string;
  roles: Record<string, string>;
  queue: number;
  busy: number;
  memoryDocs?: number;
  error?: string;
}

export function parseMetrics(text: string): { queue: number; busy: number } {
  const value = (name: string) => {
    const m = new RegExp(`^${name} ([0-9.]+)$`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { queue: value("yllm_queue_depth"), busy: value("yllm_slots_in_use") };
}

export async function readState(s: Settings, timeoutMs = 4000): Promise<State> {
  const base = s.baseUrl.replace(/\/$/, "");
  try {
    const [sys, met] = await Promise.all([
      fetch(`${base}/v1/system`, { headers: headers(s), signal: AbortSignal.timeout(timeoutMs) }),
      fetch(`${base}/metrics`, { signal: AbortSignal.timeout(timeoutMs) }),
    ]);
    const j: any = await sys.json();
    const m = parseMetrics(await met.text());
    return { ok: Boolean(j.ok), resident: j.resident?.model, roles: j.roles ?? {}, memoryDocs: j.memory?.documents, ...m };
  } catch (e: any) {
    return { ok: false, roles: {}, queue: 0, busy: 0, error: e?.name === "TimeoutError" ? "no answer (is the tunnel up?)" : String(e?.message ?? e) };
  }
}

export function statusText(st: State): { text: string; tooltip: string; warn: boolean } {
  if (!st.ok) return { text: "$(debug-disconnect) yserver", tooltip: `yserver: ${st.error ?? "not reachable"}`, warn: true };
  const waiting = st.queue > 0 ? ` · ${st.queue} waiting` : "";
  const model = (st.resident ?? "no model loaded").replace(/:latest$/, "");
  const roles = Object.entries(st.roles).map(([r, m]) => `${r}: ${m}`).join("\n");
  return { text: `$(server) ${model}${waiting}`, tooltip: `yserver is up\nloaded: ${model}\nbusy slots: ${st.busy}, waiting: ${st.queue}\n\n${roles}\n\nClick for the menu.`, warn: st.queue >= 3 };
}
