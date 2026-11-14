import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { findTopic, type Plan } from "./plan-model.ts";
import { addDays, brief, type Slot } from "./schedule.ts";
import { DraftPanel, el, howToStart, iconButton, message, subscribeState, type StateView } from "./ui-common.ts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATE_LABEL: Record<Slot["state"], string> = { done: "Done", overdue: "Overdue", today: "Today", upcoming: "Upcoming", past: "Past review" };

type EditTopic = { id?: string; title: string; objectives: string; sessions: number; status: "todo" | "done" };
type EditModule = { id?: string; title: string; topics: EditTopic[] };

function monthOf(date: string): string { return date.slice(0, 7); }
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function mountPlanView(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): () => void {
  const doc = container.ownerDocument;
  const root = el(doc, "div", "lp-view");
  container.append(root);
  const widgets: PluginWidgetHandle<unknown>[] = [];
  const hostButton = (parent: HTMLElement, label: string, variant: "default" | "ghost" | "outline" | "secondary", onClick: () => void | Promise<void>, disabled = false) => {
    const handle = ctx.ui.mountButton(parent, { label, variant, size: "sm", onClick, disabled }, { signal });
    widgets.push(handle as PluginWidgetHandle<unknown>);
    return handle;
  };

  let view: StateView | null = null;
  let tab: "calendar" | "curriculum" = "calendar";
  let month = "";
  let edit: EditModule[] | null = null;
  let dirty = false;

  const error = el(doc, "p", "lp-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const header = el(doc, "div", "lp-header");
  const tabs = el(doc, "div", "lp-tabs");
  tabs.setAttribute("role", "tablist");
  const calendarTab = el(doc, "button", "lp-tab", "Calendar");
  const curriculumTab = el(doc, "button", "lp-tab", "Curriculum");
  for (const [button, value] of [[calendarTab, "calendar"], [curriculumTab, "curriculum"]] as const) {
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => { tab = value; render(); });
    tabs.append(button);
  }
  const draft = new DraftPanel(ctx, signal, next => apply(next));
  const body = el(doc, "div", "lp-body");
  root.append(error, header, draft.root, tabs, body);

  // ---- Empty state ----
  function renderEmpty() {
    header.replaceChildren(el(doc, "h2", "lp-title", "Learning plan"));
    tabs.hidden = true;
    body.replaceChildren();
    if (view?.draft) return;
    body.append(el(doc, "p", undefined, "You don't have a plan yet. Describe your background and goal in Settings, set your study days, and generate a researched curriculum."));
    const actions = el(doc, "div", "lp-actions");
    body.append(actions);
    hostButton(actions, "Set up in Settings", "default", () => ctx.app.openSettings());
  }

  // ---- Header ----
  function renderHeader(plan: Plan, current: StateView) {
    const { stats, slots } = current.schedule;
    header.replaceChildren();
    header.append(el(doc, "h2", "lp-title", plan.title));
    const overdue = slots.filter(slot => slot.state === "overdue").length;
    const facts = [
      `${stats.topicsDone} of ${stats.topics} topics done`,
      `${stats.sessionsLeft} sessions left`,
      stats.endDate ? `projected end ${stats.endDate}` : "",
      current.profile.behindMode === "shift" ? "auto-shifting schedule" : "fixed dates",
    ].filter(Boolean).join(" · ");
    header.append(el(doc, "p", "lp-hint", facts));
    const bar = el(doc, "div", "lp-progress");
    const fill = el(doc, "div", "lp-progress__fill");
    fill.style.width = `${stats.topics ? Math.round((stats.topicsDone / stats.topics) * 100) : 0}%`;
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(stats.topicsDone));
    bar.setAttribute("aria-valuemax", String(stats.topics));
    bar.append(fill);
    header.append(bar);
    if (current.schedule.problem) header.append(el(doc, "p", "lp-error", current.schedule.problem));
    if (overdue) header.append(el(doc, "p", "lp-warning", `You're ${overdue} session${overdue === 1 ? "" : "s"} behind. Starting today's topic picks up the oldest one.`));
    header.append(howToStart(doc));
  }

  // ---- Calendar ----
  function renderCalendar(plan: Plan, current: StateView) {
    const byDate = new Map<string, Slot[]>();
    for (const slot of current.schedule.slots) byDate.set(slot.date, [...(byDate.get(slot.date) ?? []), slot]);
    month ||= monthOf(current.schedule.current?.date ?? current.today);
    const nav = el(doc, "div", "lp-month-nav");
    nav.append(
      iconButton(doc, "Previous month", "‹", () => { month = shiftMonth(month, -1); render(); }),
      el(doc, "h3", "lp-month", monthLabel(month)),
      iconButton(doc, "Next month", "›", () => { month = shiftMonth(month, 1); render(); }),
    );
    const todayButton = el(doc, "button", "lp-link", "Today");
    todayButton.type = "button";
    todayButton.addEventListener("click", () => { month = monthOf(current.today); render(); });
    nav.append(todayButton);
    const grid = el(doc, "div", "lp-grid");
    grid.setAttribute("role", "grid");
    for (const name of WEEKDAYS) grid.append(el(doc, "div", "lp-grid__weekday", name));
    const first = `${month}-01`;
    const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
    let date = addDays(first, -offset);
    for (let cell = 0; cell < 42; cell++, date = addDays(date, 1)) {
      if (cell === 35 && monthOf(date) !== month) break;
      const day = el(doc, "div", "lp-day");
      if (monthOf(date) !== month) day.classList.add("is-outside");
      if (date === current.today) day.classList.add("is-today");
      if (current.profile.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) day.classList.add("is-study");
      day.append(el(doc, "div", "lp-day__number", String(Number(date.slice(8)))));
      for (const slot of byDate.get(date) ?? []) day.append(chip(plan, slot));
      grid.append(day);
    }
    const legend = el(doc, "div", "lp-legend");
    for (const state of ["today", "upcoming", "overdue", "done"] as const) {
      const item = el(doc, "span", `lp-chip lp-chip--${state}`, STATE_LABEL[state]);
      legend.append(item);
    }
    legend.append(el(doc, "span", "lp-chip lp-chip--review", "Review"));
    body.append(nav, grid, legend);
  }

  function chip(plan: Plan, slot: Slot): HTMLElement {
    const button = el(doc, "button", `lp-chip lp-chip--${slot.state}${slot.kind === "review" ? " lp-chip--review" : ""}`);
    button.type = "button";
    if (slot.kind === "review") {
      button.textContent = "Review";
      button.setAttribute("aria-label", `${STATE_LABEL[slot.state]}: review session`);
    } else {
      const topic = findTopic(plan, slot.topicId)?.topic;
      const title = topic?.title ?? slot.topicId;
      button.textContent = slot.of > 1 ? `${title} (${slot.part}/${slot.of})` : title;
      button.title = button.textContent;
      button.setAttribute("aria-label", `${STATE_LABEL[slot.state]}: ${button.textContent}`);
    }
    button.addEventListener("click", () => openDetail(plan, slot));
    return button;
  }

  function openDetail(plan: Plan, slot: Slot) {
    let dialog: PluginWidgetHandle<unknown> | undefined;
    dialog = ctx.ui.openDialog({
      title: slot.kind === "review" ? "Review session" : "Topic",
      content: (dialogContainer, dialogSignal) => {
        const box = el(doc, "div", "lp-detail");
        dialogContainer.append(box);
        const local: PluginWidgetHandle<unknown>[] = [];
        if (slot.kind === "review") {
          box.append(el(doc, "h2", undefined, `Review · ${slot.date}`));
          box.append(el(doc, "p", undefined, "A review session consolidates these recent topics. On its day, open a new Practice session and type “start today's topic”."));
          const list = el(doc, "ul");
          for (const id of slot.topicIds) list.append(el(doc, "li", undefined, findTopic(plan, id)?.topic.title ?? id));
          box.append(list);
        } else {
          const found = findTopic(plan, slot.topicId);
          if (!found) { box.append(el(doc, "p", undefined, "This topic is no longer in the plan.")); return () => box.remove(); }
          const { module, topic } = found;
          box.append(el(doc, "h2", undefined, topic.title));
          box.append(el(doc, "p", "lp-hint", `${module.title} · ${topic.id} · ${topic.sessions} session${topic.sessions === 1 ? "" : "s"} · ${slot.date}${slot.of > 1 ? ` (session ${slot.part}/${slot.of})` : ""} · ${topic.status === "done" ? `done ${topic.completedAt ?? ""}` : STATE_LABEL[slot.state]}`));
          if (topic.objectives.length) {
            box.append(el(doc, "h3", undefined, "Objectives"));
            const list = el(doc, "ul");
            for (const objective of topic.objectives) list.append(el(doc, "li", undefined, objective));
            box.append(list);
          }
          if (topic.completionNote) box.append(el(doc, "p", "lp-note", `Completion note: ${topic.completionNote}`));
          if (topic.status !== "done") box.append(el(doc, "p", "lp-hint", `To start it, open a new Teaching or Practice session and type “start ${topic.id}”.`));
          if (topic.resources.length) {
            box.append(el(doc, "h3", undefined, "Resources"));
            const list = el(doc, "ul");
            for (const resource of topic.resources) {
              const link = el(doc, "a", undefined, resource.title);
              link.href = resource.url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              const item = el(doc, "li");
              item.append(link);
              list.append(item);
            }
            box.append(list);
          }
          if (topic.sessionIds.length) {
            box.append(el(doc, "h3", undefined, "Sessions"));
            const links = el(doc, "div", "lp-actions");
            topic.sessionIds.forEach((id, index) => local.push(ctx.ui.mountButton(links, {
              label: `Open session ${index + 1}`, variant: "outline", size: "sm",
              onClick: () => { dialog?.dispose(); ctx.app.openSession(id); },
            }, { signal: dialogSignal }) as PluginWidgetHandle<unknown>));
            box.append(links);
          }
          const actions = el(doc, "div", "lp-actions");
          const status = el(doc, "span", "lp-hint");
          status.setAttribute("role", "status");
          box.append(actions);
          local.push(ctx.ui.mountButton(actions, {
            label: "Copy prompt", size: "sm", variant: "outline",
            onClick: async () => {
              try {
                const clipboard = doc.defaultView?.navigator.clipboard;
                if (!clipboard || !view) throw new Error("Copying isn't available here.");
                await clipboard.writeText(brief(plan, slot, view.profile, "teaching"));
                status.textContent = "Prompt copied.";
              } catch (failure) { status.textContent = message(failure); }
            },
          }, { signal: dialogSignal }) as PluginWidgetHandle<unknown>);
          local.push(ctx.ui.mountButton(actions, {
            label: topic.status === "done" ? "Mark not done" : "Mark done", size: "sm", variant: topic.status === "done" ? "outline" : "default",
            onClick: async () => {
              try { apply(await ctx.call<StateView>("set-topic-status", { topicId: topic.id, done: topic.status !== "done" })); dialog?.dispose(); }
              catch (failure) { status.textContent = message(failure); }
            },
          }, { signal: dialogSignal }) as PluginWidgetHandle<unknown>);
          actions.append(status);
        }
        return () => { for (const widget of local) widget.dispose(); box.remove(); };
      },
    }, { signal }) as PluginWidgetHandle<unknown>;
  }

  // ---- Curriculum editor ----
  function toEdit(plan: Plan): EditModule[] {
    return plan.modules.map(module => ({
      id: module.id, title: module.title,
      topics: module.topics.map(topic => ({ id: topic.id, title: topic.title, objectives: topic.objectives.join("\n"), sessions: topic.sessions, status: topic.status })),
    }));
  }
  let dirtyControls: { save?: PluginWidgetHandle<{ disabled?: boolean }>; revert?: PluginWidgetHandle<{ disabled?: boolean }>; revise?: PluginWidgetHandle<{ disabled?: boolean }>; status?: HTMLElement } = {};
  /** Flag unsaved edits without re-rendering (which would steal focus from the input being typed in). */
  function markDirty() {
    if (dirty) return;
    dirty = true;
    dirtyControls.save?.update({ disabled: false });
    dirtyControls.revert?.update({ disabled: false });
    dirtyControls.revise?.update({ disabled: true });
    if (dirtyControls.status) dirtyControls.status.textContent = "Unsaved changes.";
  }
  function move<T>(list: T[], index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target]!, list[index]!];
  }

  function renderCurriculum(plan: Plan, current: StateView) {
    edit ??= toEdit(plan);
    const reviseBox = el(doc, "section", "lp-section");
    reviseBox.append(el(doc, "h3", undefined, "Revise with AI"));
    reviseBox.append(el(doc, "p", "lp-hint", "Describe the change, e.g. “more RF and antennas, less control theory, add a PCB design module”. Completed topics are kept."));
    const request = el(doc, "textarea", "lp-input lp-textarea");
    request.rows = 3;
    request.setAttribute("aria-label", "Revision request");
    const reviseActions = el(doc, "div", "lp-actions");
    const reviseStatus = el(doc, "span", "lp-hint");
    reviseBox.append(request, reviseActions);
    const reviseHandle = hostButton(reviseActions, "Revise plan", "secondary", async () => {
      reviseStatus.textContent = "";
      try { apply(await ctx.call<StateView>("revise", { request: request.value })); request.value = ""; }
      catch (failure) { reviseStatus.textContent = message(failure); }
    }, current.draft?.status === "running" || dirty);
    reviseActions.append(reviseStatus);

    const editor = el(doc, "section", "lp-section");
    editor.append(el(doc, "h3", undefined, "Edit curriculum"));
    editor.append(el(doc, "p", "lp-hint", "Rename, reorder, add or remove topics and set how many sessions each needs. One objective per line. Save to reschedule."));
    const modules = edit;
    modules.forEach((module, mIndex) => {
      const box = el(doc, "div", "lp-module");
      const head = el(doc, "div", "lp-module__head");
      const title = el(doc, "input", "lp-input lp-module__title");
      title.value = module.title;
      title.setAttribute("aria-label", `Module ${mIndex + 1} title`);
      title.addEventListener("input", () => { module.title = title.value; markDirty(); });
      head.append(
        title,
        iconButton(doc, `Move module ${module.title} up`, "↑", () => { move(modules, mIndex, -1); markDirty(); render(); }),
        iconButton(doc, `Move module ${module.title} down`, "↓", () => { move(modules, mIndex, 1); markDirty(); render(); }),
        iconButton(doc, `Delete module ${module.title}`, "✕", () => { modules.splice(mIndex, 1); markDirty(); render(); }),
      );
      box.append(head);
      module.topics.forEach((topic, tIndex) => {
        const row = el(doc, "div", `lp-topic${topic.status === "done" ? " is-done" : ""}`);
        const line = el(doc, "div", "lp-topic__line");
        const badge = el(doc, "span", "lp-topic__id", topic.status === "done" ? "✓" : (topic.id ?? "new"));
        const topicTitle = el(doc, "input", "lp-input");
        topicTitle.value = topic.title;
        topicTitle.setAttribute("aria-label", `Topic title`);
        topicTitle.addEventListener("input", () => { topic.title = topicTitle.value; markDirty(); });
        const sessions = el(doc, "input", "lp-input lp-topic__sessions");
        sessions.type = "number";
        sessions.min = "1";
        sessions.max = "4";
        sessions.value = String(topic.sessions);
        sessions.setAttribute("aria-label", `Sessions for ${topic.title}`);
        sessions.title = "Sessions";
        sessions.addEventListener("input", () => { topic.sessions = Number(sessions.value); markDirty(); });
        line.append(
          badge, topicTitle, sessions,
          iconButton(doc, `Move ${topic.title} up`, "↑", () => { move(module.topics, tIndex, -1); markDirty(); render(); }),
          iconButton(doc, `Move ${topic.title} down`, "↓", () => { move(module.topics, tIndex, 1); markDirty(); render(); }),
          iconButton(doc, `Delete ${topic.title}`, "✕", () => { module.topics.splice(tIndex, 1); markDirty(); render(); }),
        );
        const objectives = el(doc, "textarea", "lp-input lp-topic__objectives");
        objectives.rows = Math.min(5, Math.max(2, topic.objectives.split("\n").length));
        objectives.value = topic.objectives;
        objectives.placeholder = "Objectives, one per line";
        objectives.setAttribute("aria-label", `Objectives for ${topic.title}`);
        objectives.addEventListener("input", () => { topic.objectives = objectives.value; markDirty(); });
        row.append(line, objectives);
        box.append(row);
      });
      const add = el(doc, "button", "lp-link", "+ Add topic");
      add.type = "button";
      add.addEventListener("click", () => { module.topics.push({ title: "New topic", objectives: "", sessions: 1, status: "todo" }); markDirty(); render(); });
      box.append(add);
      editor.append(box);
    });
    const addModule = el(doc, "button", "lp-link", "+ Add module");
    addModule.type = "button";
    addModule.addEventListener("click", () => { modules.push({ title: "New module", topics: [{ title: "New topic", objectives: "", sessions: 1, status: "todo" }] }); markDirty(); render(); });
    const actions = el(doc, "div", "lp-actions lp-actions--sticky");
    const status = el(doc, "span", "lp-hint", dirty ? "Unsaved changes." : "");
    status.setAttribute("role", "status");
    const saveHandle = hostButton(actions, "Save changes", "default", async () => {
      try {
        const payload = modules.map(module => ({
          ...(module.id ? { id: module.id } : {}), title: module.title,
          topics: module.topics.map(topic => ({ ...(topic.id ? { id: topic.id } : {}), title: topic.title, sessions: topic.sessions, objectives: topic.objectives.split("\n").map(line => line.trim()).filter(Boolean) })),
        }));
        const next = await ctx.call<StateView>("save-plan", { modules: payload });
        dirty = false;
        edit = null;
        apply(next);
      } catch (failure) { status.textContent = message(failure); }
    }, !dirty);
    const revertHandle = hostButton(actions, "Revert", "ghost", () => { dirty = false; edit = null; render(); }, !dirty);
    actions.append(status);
    dirtyControls = { save: saveHandle, revert: revertHandle, revise: reviseHandle, status };
    editor.append(addModule, actions);
    body.append(reviseBox, editor);
  }

  // ---- Render ----
  function render() {
    for (const widget of widgets.splice(0)) widget.dispose();
    dirtyControls = {};
    const current = view;
    if (!current) return;
    error.hidden = !current.loadError;
    error.textContent = current.loadError ?? "";
    draft.update(current);
    const plan = current.plan;
    if (!plan) { renderEmpty(); return; }
    tabs.hidden = false;
    calendarTab.setAttribute("aria-selected", String(tab === "calendar"));
    curriculumTab.setAttribute("aria-selected", String(tab === "curriculum"));
    renderHeader(plan, current);
    body.replaceChildren();
    if (tab === "calendar") renderCalendar(plan, current);
    else renderCurriculum(plan, current);
  }

  function apply(next: StateView) {
    if (signal.aborted) return;
    const planChanged = JSON.stringify(view?.plan ?? null) !== JSON.stringify(next.plan);
    view = next;
    if (planChanged && !dirty) edit = null;
    // Keep in-progress edits stable: only re-render the editor when it is clean.
    if (tab === "curriculum" && dirty) { draft.update(next); return; }
    render();
  }

  subscribeState(ctx, signal, apply, failure => { error.hidden = false; error.textContent = message(failure); });

  return () => {
    for (const widget of widgets) widget.dispose();
    draft.dispose();
    root.remove();
  };
}
