import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginInstructions, PluginTools, PluginWorkerDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { Curriculum } from "../src/plan-model.ts";

type Outcome = { status: "succeeded"; result: unknown } | { status: "failed"; error: { code: string; message: string } };

const curriculum: Curriculum = {
  title: "EE plan", summary: "s", sources: [],
  modules: [{ title: "Circuits", topics: [
    { title: "Ohm's law", objectives: ["V=IR"], sessions: 1, resources: [] },
    { title: "RC circuits", objectives: ["tau"], sessions: 2, resources: [] },
  ] }],
};

function fakeHost(dataDirectory: string) {
  const instructions = new Map<number, PluginInstructions>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const workers = new Map<string, PluginWorkerDefinition>();
  const started: { id: string; prompt: string; model: unknown; purpose: string }[] = [];
  let tools: PluginTools | undefined;
  let nextInstruction = 0;
  const tasks = new Map<string, { id: string; requestId: string; status: string; turns: number; result?: unknown; error?: unknown; settle: () => void; done: Promise<void> }>();
  const ctx = {
    dataDirectory,
    signal: new AbortController().signal,
    cleanup() {},
    events: { emit() {}, on() { return () => {}; } },
    registerInstructions(value: PluginInstructions) { const id = nextInstruction++; instructions.set(id, value); return () => { instructions.delete(id); }; },
    registerTools(value: PluginTools) { tools = value; return () => { tools = undefined; }; },
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    inference: { async catalog() { return { slots: { strong: { model: { provider: "test", id: "strong" } }, cheap: null }, models: [{ provider: "test", id: "strong", supportedLevels: [] }] }; } },
    workers: {
      register(definition: PluginWorkerDefinition) { workers.set(definition.id, definition); return () => {}; },
      start(id: string, options: { requestId: string; prompt: string; model: unknown; purpose: string }) {
        started.push({ id, prompt: options.prompt, model: options.model, purpose: options.purpose });
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        const task = { id: `task-${tasks.size + 1}`, requestId: options.requestId, status: "running", turns: 0, settle, done };
        tasks.set(task.id, task);
        return { ...task };
      },
      list() { return [...tasks.values()]; },
      get(id: string) { return tasks.get(id)!; },
      subscribe() { return () => {}; },
      async wait(id: string) { await tasks.get(id)!.done; return { id }; },
      cancel(id: string) { const task = tasks.get(id)!; task.status = "cancelled"; task.error = { code: "cancelled", message: "Cancelled." }; task.settle(); },
    },
  };
  return {
    ctx: ctx as unknown as PluginBackendContext,
    call: (name: string, input: unknown = {}) => Promise.resolve(handlers.get(name)!(input)) as Promise<any>,
    instructions: () => [...instructions.values()],
    tools: (chatId = "chat-1") => tools?.create({ chatId, agent: "teacher" }) ?? [],
    workers, started,
    finish(outcome: Outcome) {
      for (const task of tasks.values()) if (task.status === "running") { Object.assign(task, outcome); task.settle(); }
    },
  };
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "learning-plan-"));
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const clock = (iso: string) => () => new Date(iso);

async function withPlan(host: ReturnType<typeof fakeHost>) {
  await host.call("save-profile", { profile: { weekdays: [1, 3, 5], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: 4, goalPrompt: "" } });
  await host.call("generate", { goal: "CS grad → EE, circuits and radio" });
  host.finish({ status: "succeeded", result: curriculum });
  await flush();
  return host.call("draft-accept");
}

test("generate runs the strong-slot worker with the user's goal, then accept creates a scheduled plan", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  assert.equal(host.instructions().length, 0);
  assert.equal(host.tools().length, 0);
  const view = await withPlan(host);
  assert.equal(host.started[0]!.id, "plan-generate-v1");
  assert.equal(host.started[0]!.purpose, "user");
  assert.deepEqual(host.started[0]!.model, { provider: "test", id: "strong" });
  assert.match(host.started[0]!.prompt, /CS grad → EE[\s\S]*3 sessions per week \(Monday, Wednesday, Friday\), about 45 minutes[\s\S]*about 4 weeks, i\.e\. roughly 12 sessions/);
  assert.equal(host.workers.get("plan-generate-v1")!.tools!({ taskId: "t", input: {}, signal: new AbortController().signal })[0]!.name, "fetch_url");
  assert.equal(view.plan.title, "EE plan");
  assert.equal(view.draft, null);
  assert.deepEqual(view.schedule.slots.map((slot: { date: string }) => slot.date), ["2026-11-02", "2026-11-04", "2026-11-06"]);
  assert.equal(view.profile.goalPrompt, "CS grad → EE, circuits and radio");
  const [teacher, practice] = host.instructions();
  assert.deepEqual([teacher!.agents, practice!.agents], [["teacher"], ["practice"]]);
  assert.match(teacher!.text, /"EE plan" \(0 of 2 topics done; today is 2026-11-02\)[\s\S]*2026-11-02: Ohm's law \[t-2\]/);
  assert.deepEqual(fs.readdirSync(dir), ["plan.json"]);
});

test("complete-topic tool uses the session linked by kickoff and reports the next item", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  await host.call("link-session", { topicId: "t-2", sessionId: "chat-9" });
  const complete = host.tools("chat-9").find(tool => tool.name === "learning_plan_complete_topic")!;
  const result = await complete.execute("call", { note: "Solved three divider problems" });
  assert.match((result.content[0] as { text: string }).text, /Marked "Ohm's law" done\. Next in the plan: RC circuits \(2026-11-04\)/);
  const view = await host.call("get-state");
  assert.equal(view.plan.modules[0].topics[0].completionNote, "Solved three divider problems");
  await assert.rejects(host.tools("other").find(tool => tool.name === "learning_plan_complete_topic")!.execute("call", { note: "x" }), /not linked/);
  const overview = await host.tools().find(tool => tool.name === "learning_plan_overview")!.execute("call", {});
  assert.match((overview.content[0] as { text: string }).text, /\[t-2\] Ohm's law \(1 session, done 2026-11-02\)/);
});

test("start-topic tool links a session started without the button and returns the brief", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  assert.match(host.instructions()[0]!.text, /offers today's planned item \(2026-11-02: Ohm's law \[t-2\]\)[\s\S]*call learning_plan_start_topic/);
  const start = (chatId: string) => host.tools(chatId).find(tool => tool.name === "learning_plan_start_topic")!;

  const today = await start("chat-new").execute("call", {});
  assert.match((today.content[0] as { text: string }).text, /^Linked this session to t-2\.\n\[Learning plan\] Teach me "Ohm's law" \(module: Circuits; about 45 minutes\)\.\nObjectives:\n- V=IR$/);
  let view = await host.call("get-state");
  assert.deepEqual(view.plan.modules[0].topics[0].sessionIds, ["chat-new"]);

  const second = await start("chat-rc").execute("call", { topicId: "t-3" });
  assert.match((second.content[0] as { text: string }).text, /session 1 of 2/);
  const again = await start("chat-rc").execute("call", { topicId: "t-3" });
  assert.match((again.content[0] as { text: string }).text, /session 1 of 2/, "re-starting in the same session keeps its part");
  view = await host.call("get-state");
  assert.deepEqual(view.plan.modules[0].topics[1].sessionIds, ["chat-rc"]);

  const complete = host.tools("chat-new").find(tool => tool.name === "learning_plan_complete_topic")!;
  await complete.execute("call", { note: "ok" });
  await assert.rejects(start("x").execute("call", { topicId: "t-99" }), /Unknown topic t-99/);
});

test("revise keeps completed topics; failed runs are reported; one run at a time", async () => {
  const host = fakeHost(temp());
  activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  await host.call("set-topic-status", { topicId: "t-2", done: true });
  await host.call("revise", { request: "more RF" });
  await assert.rejects(host.call("revise", { request: "again" }), /already in progress/);
  assert.equal(host.started[1]!.id, "plan-revise-v1");
  assert.match(host.started[1]!.prompt, /\[done\] Ohm's law[\s\S]*\[todo\] RC circuits[\s\S]*more RF/);
  host.finish({ status: "succeeded", result: { ...curriculum, modules: [{ title: "RF", topics: [{ title: "Antennas", objectives: ["x"], sessions: 1, resources: [] }] }] } });
  await flush();
  const accepted = await host.call("draft-accept");
  assert.deepEqual(accepted.plan.modules.flatMap((module: { topics: { title: string; status: string }[] }) => module.topics.map(topic => `${topic.title}:${topic.status}`)), ["Ohm's law:done", "Antennas:todo"]);

  await host.call("revise", { request: "x" });
  host.finish({ status: "failed", error: { code: "no_result", message: "No result." } });
  await flush();
  const failed = await host.call("get-state");
  assert.equal(failed.draft.status, "failed");
  assert.equal(failed.draft.error, "No result.");
});

test("data persists across restarts and newer formats are never overwritten", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  const dispose = activate(host.ctx, { now: clock("2026-11-02T12:00:00") });
  await withPlan(host);
  dispose();
  const again = fakeHost(dir);
  activate(again.ctx, { now: clock("2026-11-09T12:00:00") });
  const view = await again.call("get-state");
  assert.equal(view.plan.title, "EE plan");
  assert.deepEqual(view.schedule.slots.map((slot: { state: string }) => slot.state), ["overdue", "overdue", "overdue"]);

  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify({ version: 7 }));
  const newer = fakeHost(dir);
  activate(newer.ctx);
  assert.match((await newer.call("get-state")).loadError, /newer than this plugin understands/);
  await assert.rejects(newer.call("set-model-override", { model: null }), /Fix or move the file/);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ version: 7 }));
});
