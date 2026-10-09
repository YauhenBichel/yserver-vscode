// Copyright 2026 Yauhen Bichel
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { buildMessages, loadRules, loadSkills, readState, Settings, Skill, State, statusText, streamChat } from "./core";

let current: AbortController | undefined;
let lastAnswer = "";

function settings(): Settings {
  const c = vscode.workspace.getConfiguration("yserver");
  return { baseUrl: c.get("baseUrl", ""), apiKey: c.get("apiKey", ""), model: c.get("model", "yserver"),
    interactive: c.get("interactive", true), maxTokens: c.get("maxTokens", 8000) };
}

function selection(): { code?: string; fileName?: string; language?: string } {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return {};
  const code = ed.selection.isEmpty ? undefined : ed.document.getText(ed.selection);
  return { code, fileName: vscode.workspace.asRelativePath(ed.document.uri), language: ed.document.languageId };
}

/** Open a Markdown document beside the editor and stream the answer into it. */
async function answer(title: string, skill: Skill | undefined, question: string): Promise<void> {
  if (!settings().baseUrl) { await needsSetting("baseUrl", "Set the server address first."); return; }
  const cfg = vscode.workspace.getConfiguration("yserver");
  const sel = selection();
  const rules = loadRules(cfg.get("rulesDir", "~/.continue/rules"), sel.fileName);
  const messages = buildMessages({ rules, skill, question, ...sel });
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: `# ${title}\n\n_Asking yserver..._\n\n` });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true });
  let thinkingShown = false;
  let pending = "";
  const append = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, text);
    await vscode.workspace.applyEdit(edit);
  };
  let flushing = Promise.resolve();
  const flush = () => { const t = pending; pending = ""; if (t) flushing = flushing.then(() => append(t)); };
  const timer = setInterval(flush, 150);
  current?.abort();
  current = new AbortController();
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "yserver" }, (progress) =>
      streamChat(settings(), messages, (t) => { pending += t; }, (chars) => {
        progress.report({ message: `thinking (${chars} characters)` });
        if (!thinkingShown) { thinkingShown = true; pending += "_The model is thinking first..._\n\n"; }
      }, current!.signal));
    clearInterval(timer); flush(); await flushing;
    lastAnswer = r.text;
    const queued = r.queueMs !== null ? `, waited ${(r.queueMs / 1000).toFixed(1)} s in the queue` : "";
    await append(`\n\n---\n_${r.model || "yserver"}, ${r.seconds.toFixed(1)} s${queued}${skill ? `, skill ${skill.name}` : ""}. Run "yserver: Apply the last code block" to replace the selection._\n`);
  } catch (e: any) {
    clearInterval(timer); flush(); await flushing;
    await append(`\n\n**${e?.name === "AbortError" ? "Stopped." : "Error: " + (e?.message ?? e)}**\n`);
  } finally {
    current = undefined;
  }
}

async function ask(): Promise<void> {
  const q = await vscode.window.showInputBox({ prompt: "Ask yserver (the selection is sent with the question)", placeHolder: "What does this do? / Write a test for it / Why does it fail?" });
  if (q) await answer(q.length > 60 ? q.slice(0, 57) + "..." : q, undefined, q);
}

async function runSkill(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("yserver");
  const skills = loadSkills(cfg.get<string[]>("skillsDirs", []));
  if (!skills.length) { vscode.window.showWarningMessage("No skills found. Set yserver.skillsDirs to a folder of <name>/SKILL.md."); return; }
  const pick = await vscode.window.showQuickPick(skills.map((s) => ({ label: s.name, detail: s.description, skill: s })),
    { placeHolder: "Which skill?", matchOnDetail: true });
  if (!pick) return;
  const extra = await vscode.window.showInputBox({ prompt: `${pick.skill.name}: anything to add? (Enter to skip)` });
  if (extra === undefined) return;
  await answer(pick.skill.name, pick.skill, extra || `Apply the ${pick.skill.name} skill to the selected code.`);
}

async function applyLast(): Promise<void> {
  const blocks = [...lastAnswer.matchAll(/```[\w+-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.languageId !== "markdown" || !e.document.isUntitled) ?? vscode.window.activeTextEditor;
  if (!blocks.length || !ed) { vscode.window.showInformationMessage("No code block in the last answer, or no editor."); return; }
  const code = blocks[blocks.length - 1];
  const ok = await vscode.window.showWarningMessage(`Replace the selection in ${vscode.workspace.asRelativePath(ed.document.uri)} with the last code block (${code.split("\n").length} lines)?`, { modal: true }, "Replace");
  if (ok !== "Replace") return;
  await ed.edit((b) => b.replace(ed.selection.isEmpty ? new vscode.Range(ed.selection.start, ed.selection.start) : ed.selection, code));
}

async function needsSetting(name: string, message: string): Promise<void> {
  if (await vscode.window.showWarningMessage(message, "Open settings") === "Open settings")
    await vscode.commands.executeCommand("workbench.action.openSettings", `yserver.${name}`);
}

function ssh(command: string): Promise<string> {
  const host = vscode.workspace.getConfiguration("yserver").get("sshHost", "");
  if (!/^[\w@.-]+$/.test(host)) return Promise.reject(new Error("set yserver.sshHost"));
  return new Promise((resolve, reject) => execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command], { timeout: 30000 },
    (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim()))));
}

async function pipelines(action: "stop" | "start"): Promise<void> {
  const units = vscode.workspace.getConfiguration("yserver").get<string[]>("pipelines", []);
  const safe = units.filter((u) => /^[\w@.-]+$/.test(u));
  if (!safe.length) { await needsSetting("pipelines", "No services to pause or resume: set yserver.pipelines."); return; }
  if (action === "stop") {
    const ok = await vscode.window.showWarningMessage(`Pause ${safe.join(", ")} on the server? Their running step is stopped; start them again with "Resume the pipelines".`, { modal: true }, "Pause");
    if (ok !== "Pause") return;
  }
  try {
    const out = await ssh(`systemctl --user ${action} ${safe.join(" ")} && systemctl --user is-active ${safe.join(" ")} || true`);
    vscode.window.showInformationMessage(`Services: ${out.split("\n").join(", ")}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not ${action} the pipelines: ${e.message}`);
  }
}

async function showStatus(st: State): Promise<void> {
  const lines = [st.ok ? "yserver is up" : `yserver: ${st.error}`, `loaded model: ${st.resident ?? "-"}`, `busy: ${st.busy}, waiting: ${st.queue}`,
    `memory documents: ${st.memoryDocs ?? "-"}`, "", ...Object.entries(st.roles).map(([r, m]) => `${r}: ${m}`)];
  const doc = await vscode.workspace.openTextDocument({ language: "plaintext", content: lines.join("\n") });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = "yserver.menu";
  item.text = "$(sync~spin) yserver";
  item.show();
  let state: State = { ok: false, roles: {}, queue: 0, busy: 0, error: "not checked yet" };
  const refresh = async () => {
    if (!settings().baseUrl) { item.text = "$(gear) yserver: not set up"; item.tooltip = "Set yserver.baseUrl in the settings"; item.backgroundColor = undefined; return; }
    state = await readState(settings());
    const s = statusText(state);
    item.text = s.text;
    item.tooltip = s.tooltip;
    item.backgroundColor = s.warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  };
  void refresh();
  const every = Math.max(3, vscode.workspace.getConfiguration("yserver").get("refreshSeconds", 10)) * 1000;
  const timer = setInterval(() => void refresh(), every);
  context.subscriptions.push(item, { dispose: () => clearInterval(timer) });

  const reg = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("yserver.ask", ask);
  reg("yserver.skill", runSkill);
  reg("yserver.applyLast", applyLast);
  reg("yserver.stop", () => current?.abort());
  reg("yserver.status", async () => { await refresh(); await showStatus(state); });
  reg("yserver.pausePipelines", () => pipelines("stop"));
  reg("yserver.resumePipelines", () => pipelines("start"));
  reg("yserver.openPages", async () => {
    const pages = vscode.workspace.getConfiguration("yserver").get<Record<string, string>>("pages", {});
    if (!Object.keys(pages).length) { await needsSetting("pages", "No pages: set yserver.pages."); return; }
    const pick = await vscode.window.showQuickPick(Object.keys(pages), { placeHolder: "Open which page?" });
    if (pick) await vscode.env.openExternal(vscode.Uri.parse(pages[pick]));
  });
  reg("yserver.menu", async () => {
    const items = [
      { label: "$(comment-discussion) Ask about the selection", cmd: "yserver.ask" },
      { label: "$(checklist) Run a skill on the selection", cmd: "yserver.skill" },
      { label: "$(replace) Apply the last code block", cmd: "yserver.applyLast" },
      { label: "$(debug-stop) Stop the answer", cmd: "yserver.stop" },
      { label: "$(info) Show status", cmd: "yserver.status" },
      { label: "$(debug-pause) Pause the pipelines", cmd: "yserver.pausePipelines" },
      { label: "$(debug-start) Resume the pipelines", cmd: "yserver.resumePipelines" },
      { label: "$(link-external) Open a status page", cmd: "yserver.openPages" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: statusText(state).tooltip.split("\n")[0] });
    if (pick) await vscode.commands.executeCommand(pick.cmd);
  });
}

export function deactivate(): void {
  current?.abort();
}
