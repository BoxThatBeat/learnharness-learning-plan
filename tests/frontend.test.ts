/** DOM smoke/integration test: the real frontend against the real backend through a fake
 * host. Host widgets are minimal stand-ins (plain buttons/dialog containers), so this checks
 * plugin logic and wiring, not host rendering. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { PluginAction, PluginBackendContext, PluginFrontendContext, PluginSubmissionInterceptor, PluginView } from "learnharness-plugin-api";
import { activate as activateBackend } from "../src/backend.ts";
import { activate as activateFrontend } from "../src/main.ts";

const window = new Window();
Object.assign(globalThis, { document: window.document, HTMLElement: window.HTMLElement });
const doc = window.document as unknown as Document;
const flush = () => new Promise(resolve => setTimeout(resolve, 25));

const curriculum = {
  title: "EE plan", summary: "Circuits first.", sources: [],
  modules: [{ title: "Circuits", topics: [
    { title: "Ohm's law", objectives: ["Apply V=IR"], sessions: 1, resources: [{ title: "Notes", url: "https://example.edu/ohm" }] },
    { title: "RC circuits", objectives: ["tau"], sessions: 2, resources: [] },
  ] }],
};

function backend() {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const tasks: { status: string; result?: unknown; settle: () => void; done: Promise<void>; requestId: string; id: string; turns: number }[] = [];
  const ctx = {
    dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "learning-plan-ui-")),
    signal: new AbortController().signal,
    events: { emit() {}, on() { return () => {}; } },
    registerInstructions() { return () => {}; },
    registerTools() { return () => {}; },
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => {}; },
    inference: { async catalog() { return { slots: { strong: { model: { provider: "p", id: "m" } } }, models: [{ provider: "p", id: "m", supportedLevels: [] }] }; } },
    workers: {
      register() { return () => {}; },
      start(_id: string, options: { requestId: string }) {
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        const task = { id: `task-${tasks.length}`, requestId: options.requestId, status: "running", turns: 0, settle, done };
        tasks.push(task);
        return { ...task };
      },
      list: () => tasks,
      get: (id: string) => tasks.find(task => task.id === id)!,
      subscribe() { return () => {}; },
      async wait(id: string) { await tasks.find(task => task.id === id)!.done; return { id }; },
      cancel() {},
    },
  };
  activateBackend(ctx as unknown as PluginBackendContext, { now: () => new Date("2026-11-02T12:00:00") });
  return {
    call: (name: string, input: unknown = {}) => Promise.resolve().then(() => handlers.get(name)!(input)),
    finish() { for (const task of tasks) if (task.status === "running") { task.status = "succeeded"; task.result = curriculum; task.settle(); } },
  };
}

function frontendHost(call: (name: string, input?: unknown) => Promise<unknown>) {
  const views = new Map<string, PluginView>();
  const actions = new Map<string, PluginAction>();
  const placements: unknown[] = [];
  const interceptors: PluginSubmissionInterceptor[] = [];
  const calls: string[] = [];
  let settings: ((container: HTMLElement, signal: AbortSignal) => unknown) | undefined;
  const button = (container: HTMLElement, props: Record<string, unknown>, options: { signal: AbortSignal }) => {
    const node = doc.createElement("button");
    let current = { ...props };
    const paint = () => { node.textContent = String(current.label); node.disabled = Boolean(current.disabled); };
    node.addEventListener("click", () => { if (!current.disabled) void (current.onClick as () => unknown)(); });
    paint();
    container.append(node);
    options.signal.addEventListener("abort", () => node.remove());
    return { update(next: Record<string, unknown>) { current = { ...current, ...next }; paint(); }, dispose() { node.remove(); } };
  };
  const ctx = {
    signal: new AbortController().signal,
    call: async (name: string, input?: unknown) => { calls.push(name); return call(name, input); },
    registerView(view: PluginView) { views.set(view.id, view); return () => {}; },
    registerAction(action: PluginAction) { actions.set(action.id, action); return () => {}; },
    placeAction(placement: unknown) { placements.push(placement); return () => {}; },
    registerSettings(mount: typeof settings) { settings = mount; return () => {}; },
    registerSubmissionInterceptor(definition: PluginSubmissionInterceptor) { interceptors.push(definition); return () => {}; },
    refreshSubmissions() {},
    onNotification() { return () => {}; },
    onResync() { return () => {}; },
    app: { openView() {}, openSettings() {}, openSession() {}, openHome() {}, pathname: () => "/" },
    ui: {
      mountButton: button,
      mountModelPicker(container: HTMLElement) { const node = doc.createElement("span"); container.append(node); return { update() {}, dispose() { node.remove(); } }; },
      openDialog(props: { content: (container: HTMLElement, signal: AbortSignal) => unknown }) {
        const controller = new AbortController();
        const box = doc.createElement("div");
        box.className = "test-dialog";
        doc.body.append(box);
        const cleanup = props.content(box, controller.signal);
        return { update() {}, dispose() { controller.abort(); if (typeof cleanup === "function") (cleanup as () => void)(); box.remove(); } };
      },
    },
  };
  activateFrontend(ctx as unknown as PluginFrontendContext);
  return { views, actions, placements, interceptors, calls, settings: () => settings! };
}

const clickButton = (root: ParentNode, label: string) => {
  const target = [...root.querySelectorAll("button")].find(node => node.textContent === label);
  assert.ok(target, `button "${label}" exists`);
  (target as HTMLButtonElement).click();
};

test("sidebar tab, calendar, curriculum editing and the kickoff interceptor work end to end", async () => {
  const server = backend();
  await server.call("save-profile", { profile: { weekdays: [1, 3, 5], minutesPerSession: 45, startDate: "2026-11-02", reviewEvery: 0, behindMode: "fixed", targetWeeks: null, goalPrompt: "" } });
  const host = frontendHost(server.call);
  assert.deepEqual(host.placements.map(placement => (placement as { location: string }).location).sort(), ["sidebar", "top-bar"]);

  // Settings: generate a plan through the UI and accept the draft.
  const settingsRoot = doc.createElement("div");
  doc.body.append(settingsRoot);
  const settingsSignal = new AbortController();
  host.settings()(settingsRoot, settingsSignal.signal);
  await flush();
  const boxes = [...settingsRoot.querySelectorAll(".lp-day-toggle input")] as HTMLInputElement[];
  assert.deepEqual(boxes.map(box => box.checked), [true, false, true, false, true, false, false]);
  (settingsRoot.querySelector("textarea") as HTMLTextAreaElement).value = "CS grad → EE";
  settingsRoot.querySelector("textarea")!.dispatchEvent(new window.Event("input") as unknown as Event);
  clickButton(settingsRoot, "Generate plan");
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Generating your plan/);
  server.finish();
  await flush();
  await (host.settings() && server.call("get-state"));
  // No live notifications in this fake: re-mount settings to read the ready draft.
  settingsSignal.abort();
  settingsRoot.replaceChildren();
  host.settings()(settingsRoot, new AbortController().signal);
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Draft ready: "EE plan" — 1 modules, 2 topics, 3 sessions/);
  clickButton(settingsRoot, "Accept plan");
  await flush();
  assert.match(settingsRoot.textContent ?? "", /Regenerate plan/);

  // Calendar view.
  const viewRoot = doc.createElement("div");
  doc.body.append(viewRoot);
  host.views.get("calendar")!.mount(viewRoot, new AbortController().signal);
  await flush();
  assert.match(viewRoot.querySelector(".lp-title")!.textContent!, /EE plan/);
  const chips = [...viewRoot.querySelectorAll(".lp-grid .lp-chip")].map(node => `${node.textContent}|${node.className}`);
  assert.deepEqual(chips, ["Ohm's law|lp-chip lp-chip--today", "RC circuits (1/2)|lp-chip lp-chip--upcoming", "RC circuits (2/2)|lp-chip lp-chip--upcoming"]);
  (viewRoot.querySelector(".lp-chip--today") as HTMLButtonElement).click();
  const detail = doc.querySelector(".test-dialog")!;
  assert.match(detail.textContent!, /Ohm's law[\s\S]*Apply V=IR[\s\S]*Notes/);
  assert.equal((detail.querySelector("a") as HTMLAnchorElement).rel, "noopener noreferrer");
  detail.remove();

  // Curriculum editing keeps focus while typing and saves.
  clickButton(viewRoot, "Curriculum");
  const title = viewRoot.querySelector(".lp-topic input") as HTMLInputElement;
  title.focus();
  title.value = "Ohm's and Kirchhoff's laws";
  title.dispatchEvent(new window.Event("input") as unknown as Event);
  assert.equal(title.isConnected, true, "typing does not re-render the editor");
  clickButton(viewRoot, "Save changes");
  await flush();
  const saved = await server.call("get-state") as { plan: { modules: { topics: { title: string }[] }[] } };
  assert.equal(saved.plan.modules[0]!.topics[0]!.title, "Ohm's and Kirchhoff's laws");

  // Kickoff from a teaching session's top bar.
  const interceptor = host.interceptors[0]!;
  const target = { type: "text", sessionId: "s-1", sessionKind: "teaching", channels: ["content"] } as never;
  assert.equal(interceptor.hasPendingInput!(target), false);
  await host.actions.get("todays-topic")!.run({ placement: "top-bar", surface: "session", sessionId: "s-1", kind: "teaching" } as never);
  await flush();
  const dialog = doc.querySelector(".test-dialog")!;
  assert.match(dialog.querySelector("pre")!.textContent!, /^\[Learning plan\] Teach me "Ohm's and Kirchhoff's laws"/);
  clickButton(dialog, "Attach to my next message");
  assert.equal(interceptor.hasPendingInput!(target), true);
  const accepted: (() => void | Promise<void>)[] = [];
  const result = await interceptor.intercept(
    { type: "text", content: { text: "go", images: [] } },
    { ...(target as object), messages: [], signal: new AbortController().signal, onAccepted: (callback: () => void) => accepted.push(callback) } as never,
  ) as { content: { text: string } };
  assert.match(result.content.text, /^\[Learning plan\] Teach me[\s\S]*\n\ngo$/);
  assert.equal(interceptor.hasPendingInput!(target), true, "still attached until the host acknowledges the send");
  await accepted[0]!();
  assert.equal(interceptor.hasPendingInput!(target), false);
  const linked = await server.call("get-state") as { plan: { modules: { topics: { sessionIds: string[] }[] }[] } };
  assert.deepEqual(linked.plan.modules[0]!.topics[0]!.sessionIds, ["s-1"]);
  assert.equal(await interceptor.intercept({ type: "text", content: { text: "next", images: [] } }, { ...(target as object), onAccepted() {} } as never), undefined);
});
