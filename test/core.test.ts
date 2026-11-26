import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildMessages, frontMatter, globsMatch, loadRules, loadSkills, parseMetrics, parseSse, readState, statusText, streamChat } from "../src/core";

test("front matter and glob matching", () => {
  const { meta, body } = frontMatter("---\nname: Tests\nglobs: [\"**/test_*.py\", \"**/tests/**\"]\nalwaysApply: false\n---\nBody here\n");
  assert.equal(meta.name, "Tests");
  assert.equal(body, "Body here");
  assert.ok(globsMatch(meta.globs, "src/tests/test_orders.py"));
  assert.ok(globsMatch(meta.globs, "test_x.py"));
  assert.ok(!globsMatch(meta.globs, "src/orders.py"));
  assert.ok(globsMatch('["**/*.py"]', "a/b/c.py") && !globsMatch('["**/*.py"]', "a/b/c.ts"));
});

test("skills and rules are read from disk", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ys-"));
  fs.mkdirSync(path.join(d, "skills", "debug"), { recursive: true });
  fs.writeFileSync(path.join(d, "skills", "debug", "SKILL.md"), "---\nname: debug\ndescription: Finds bugs.\n---\n## Steps\n1. Reproduce.\n");
  fs.mkdirSync(path.join(d, "skills", "empty"));
  const skills = loadSkills([path.join(d, "skills"), path.join(d, "missing")]);
  assert.deepEqual(skills.map((s) => [s.name, s.description]), [["debug", "Finds bugs."]]);
  fs.mkdirSync(path.join(d, "rules"));
  fs.writeFileSync(path.join(d, "rules", "01.md"), "---\nalwaysApply: true\n---\nALWAYS\n");
  fs.writeFileSync(path.join(d, "rules", "02.md"), "---\nglobs: [\"**/*.py\"]\n---\nPYTHON\n");
  assert.equal(loadRules(path.join(d, "rules"), "src/a.py"), "ALWAYS\n\nPYTHON");
  assert.equal(loadRules(path.join(d, "rules"), "src/a.ts"), "ALWAYS");
  assert.equal(loadRules(path.join(d, "nope")), "");
  const m = buildMessages({ rules: "R", skill: skills[0], question: "Q", code: "x = 1", fileName: "a.py", language: "python" });
  assert.equal(m[0].role, "system");
  assert.ok(m[0].content.startsWith("R") && m[0].content.includes("Reproduce"));
  assert.ok(m[1].content.includes("```python\nx = 1\n```"));
  assert.equal(buildMessages({ rules: "", question: "Q" }).length, 1);
});

test("SSE parsing keeps an unfinished event for later", () => {
  const { events, rest } = parseSse('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c"');
});

test("status from metrics and system info", () => {
  assert.deepEqual(parseMetrics("# HELP x\nyllm_queue_depth 3\nyllm_slots_in_use 1\n"), { queue: 3, busy: 1 });
  const s = statusText({ ok: true, resident: "qwen3.6-coder:35b", roles: { coder: "c" }, queue: 3, busy: 1 });
  assert.ok(s.text.includes("qwen3.6-coder:35b · 3 waiting") && s.warn);
  assert.ok(statusText({ ok: false, roles: {}, queue: 0, busy: 0, error: "down" }).warn);
});

test("streaming against a fake gateway: text, hidden reasoning, queue time, priority header", async () => {
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/v1/system") { res.end(JSON.stringify({ ok: true, resident: { model: "m" }, roles: { coder: "m" } })); return; }
    if (req.url === "/metrics") { res.end("yllm_queue_depth 0\nyllm_slots_in_use 1\n"); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "x-yllm-queue-ms": "1500" });
    const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ model: "m", choices: [{ delta: { reasoning: "let me think" } }] });
    ev({ model: "m", choices: [{ delta: { content: "Hel" } }] });
    ev({ model: "m", choices: [{ delta: { content: "lo" } }] });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const s = { baseUrl: `http://127.0.0.1:${port}`, apiKey: "", model: "yserver", interactive: true, memory: false, maxTokens: 100 };
  let text = ""; let thinking = 0;
  const r = await streamChat(s, [{ role: "user", content: "hi" }], (t) => { text += t; }, (c) => { thinking = c; });
  assert.equal(text, "Hello"); assert.equal(r.text, "Hello"); assert.equal(thinking, "let me think".length);
  assert.equal(r.queueMs, 1500); assert.equal(r.model, "m");
  assert.equal(seen["x-yllm-priority"], "interactive");
  assert.equal(seen["x-yllm-memory"], "off");
  const st = await readState(s);
  assert.equal(st.resident, "m"); assert.equal(st.busy, 1);
  server.close();
  const down = await readState({ ...s, baseUrl: "http://127.0.0.1:9" }, 500);
  assert.equal(down.ok, false);
});
