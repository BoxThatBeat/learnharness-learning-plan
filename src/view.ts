import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { findTopic, type Plan } from "./plan-model.ts";
import { addDays, blockSlot, brief, layoutWeek, type Block, type Slot } from "./schedule.ts";
import { DraftPanel, el, howToStart, iconButton, message, planActive, planColor, planLabel, subscribeState, type PlanView, type StateView } from "./ui-common.ts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATE_LABEL: Record<Slot["state"], string> = { done: "Done", overdue: "Overdue", today: "Today", upcoming: "Upcoming", past: "Past review" };

type EditTopic = { id?: string; title: string; objectives: string; sessions: number; status: "todo" | "done" };
type EditModule = { id?: string; title: string; topics: EditTopic[] };
/** Something drawn on the calendar: a topic's block of days or a one-day review, from one course. */
type CalendarItem = { start: string; end: string; entry: PlanView; block?: Block; review?: Slot };

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
  /** The course whose curriculum is open. */
  let selected = "";
  let month = "";
  /** Curriculum edits are kept per course, so switching course tabs never loses typing. */
  const edits = new Map<string, EditModule[]>();
  const dirtyPlans = new Set<string>();
  const isDirty = () => dirtyPlans.has(selected);

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
  const planTabs = el(doc, "div", "lp-tabs lp-tabs--plans");
  planTabs.setAttribute("role", "tablist");
  planTabs.setAttribute("aria-label", "Courses");
  const drafts = el(doc, "div", "lp-drafts");
  const panels = new Map<string, DraftPanel>();
  const body = el(doc, "div", "lp-body");
  root.append(error, header, drafts, tabs, planTabs, body);

  const withCurriculum = (current: StateView) => planActive(current).filter(entry => entry.plan);
  const colorize = (node: HTMLElement, entry: PlanView) => node.style.setProperty("--lp-plan", planColor(entry.hue));
  const swatch = (entry: PlanView) => {
    const dot = el(doc, "span", "lp-swatch");
    colorize(dot, entry);
    return dot;
  };

  // ---- Empty state ----
  function renderEmpty(current: StateView) {
    header.replaceChildren(el(doc, "h2", "lp-title", "Learning plan"));
    tabs.hidden = true;
    planTabs.hidden = true;
    body.replaceChildren();
    if (current.plans.some(entry => entry.draft)) return;
    const archived = current.plans.length > 0 && planActive(current).length === 0;
    body.append(el(doc, "p", undefined, archived
      ? "All of your plans are archived. Unarchive one in Settings to see it here."
      : "You don't have a plan yet. Describe your background and goal in Settings, set your study days, and generate a researched curriculum."));
    const actions = el(doc, "div", "lp-actions");
    body.append(actions);
    hostButton(actions, "Open Settings", "default", () => ctx.app.openSettings());
  }

  // ---- Header ----
  function planFacts(entry: PlanView): string {
    const { stats } = entry.schedule;
    return [
      `${stats.topicsDone} of ${stats.topics} topics done`,
      `${stats.sessionsLeft} sessions left`,
      stats.endDate ? `projected end ${stats.endDate}` : "",
      entry.profile.behindMode === "shift" ? "auto-shifting schedule" : "fixed dates",
    ].filter(Boolean).join(" · ");
  }
  function progressBar(entry: PlanView): HTMLElement {
    const { stats } = entry.schedule;
    const bar = el(doc, "div", "lp-progress");
    const fill = el(doc, "div", "lp-progress__fill");
    fill.style.width = `${stats.topics ? Math.round((stats.topicsDone / stats.topics) * 100) : 0}%`;
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(stats.topicsDone));
    bar.setAttribute("aria-valuemax", String(stats.topics));
    colorize(bar, entry);
    bar.append(fill);
    return bar;
  }
  function planProblems(entry: PlanView, named: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    const who = named ? `${planLabel(entry)}: ` : "";
    if (entry.schedule.problem) out.push(el(doc, "p", "lp-error", `${who}${entry.schedule.problem}`));
    const overdue = entry.schedule.slots.filter(slot => slot.state === "overdue").length;
    if (overdue) out.push(el(doc, "p", "lp-warning", `${who}You're ${overdue} session${overdue === 1 ? "" : "s"} behind. Starting today's topic picks up the oldest one.`));
    return out;
  }
  function renderHeader(current: StateView) {
    header.replaceChildren();
    const plans = withCurriculum(current);
    if (tab === "calendar") {
      header.append(el(doc, "h2", "lp-title", plans.length > 1 ? "Learning plans" : "Learning plan"));
      for (const entry of plans) {
        const row = el(doc, "div", "lp-plan-row");
        const name = el(doc, "div", "lp-plan-row__name");
        name.append(swatch(entry), el(doc, "strong", undefined, planLabel(entry)));
        row.append(name, el(doc, "p", "lp-hint", planFacts(entry)), progressBar(entry), ...planProblems(entry, false));
        header.append(row);
      }
    } else {
      const entry = plans.find(candidate => candidate.id === selected)!;
      const title = el(doc, "h2", "lp-title");
      title.append(swatch(entry), entry.plan!.title);
      header.append(title, el(doc, "p", "lp-hint", planFacts(entry)), progressBar(entry), ...planProblems(entry, false));
    }
    header.append(howToStart(doc));
  }

  /** One drafts panel per course, so a generation running for one course doesn't hide another's. */
  function renderDrafts(current: StateView) {
    const many = planActive(current).length > 1;
    const live = new Set(planActive(current).map(entry => entry.id));
    for (const [id, panel] of panels) if (!live.has(id)) { panel.dispose(); panels.delete(id); }
    for (const entry of planActive(current)) {
      let panel = panels.get(entry.id);
      if (!panel) {
        panel = new DraftPanel(ctx, signal, next => apply(next));
        panels.set(entry.id, panel);
      }
      drafts.append(panel.root);
      panel.update(entry, many ? planLabel(entry) : "");
    }
  }

  function renderPlanTabs(current: StateView) {
    planTabs.replaceChildren();
    planTabs.hidden = tab !== "curriculum";
    if (tab !== "curriculum") return;
    for (const entry of withCurriculum(current)) {
      const button = el(doc, "button", "lp-tab lp-tab--plan");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(entry.id === selected));
      button.append(swatch(entry), doc.createTextNode(planLabel(entry)));
      if (dirtyPlans.has(entry.id)) button.append(el(doc, "span", "lp-hint", " •"));
      button.addEventListener("click", () => { selected = entry.id; render(); });
      planTabs.append(button);
    }
  }

  // ---- Calendar ----
  function calendarItems(current: StateView): CalendarItem[] {
    return withCurriculum(current).flatMap(entry => [
      ...entry.schedule.blocks.map((block): CalendarItem => ({ start: block.start, end: block.end, entry, block })),
      ...entry.schedule.slots.flatMap((slot): CalendarItem[] => slot.kind === "review" ? [{ start: slot.date, end: slot.date, entry, review: slot }] : []),
    ]);
  }

  function renderCalendar(current: StateView) {
    const items = calendarItems(current);
    const soonest = withCurriculum(current).map(entry => entry.schedule.current?.date).filter((date): date is string => Boolean(date)).sort()[0];
    month ||= monthOf(soonest ?? current.today);
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
    const names = el(doc, "div", "lp-grid__weekdays");
    for (const name of WEEKDAYS) names.append(el(doc, "div", "lp-grid__weekday", name));
    grid.append(names);
    const first = `${month}-01`;
    const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
    let weekStart = addDays(first, -offset);
    const studyDays = new Set(withCurriculum(current).flatMap(entry => entry.profile.weekdays));
    for (let w = 0; w < 6; w++, weekStart = addDays(weekStart, 7)) {
      if (w === 5 && monthOf(weekStart) !== month) break;
      grid.append(renderWeek(current, weekStart, items, studyDays));
    }
    const legend = el(doc, "div", "lp-legend");
    for (const entry of withCurriculum(current)) {
      const key = el(doc, "span", "lp-key");
      key.append(swatch(entry), doc.createTextNode(planLabel(entry)));
      legend.append(key);
    }
    legend.append(el(doc, "span", "lp-key lp-key--done", "Done"), el(doc, "span", "lp-key lp-key--overdue", "Overdue"));
    body.append(nav, grid, legend);
  }

  /** One calendar week: day cells behind, then every item in its own lane so same-day sessions stack. */
  function renderWeek(current: StateView, weekStart: string, items: CalendarItem[], studyDays: Set<number>): HTMLElement {
    const week = el(doc, "div", "lp-week");
    const { bars, lanes } = layoutWeek(items, weekStart);
    week.style.gridTemplateRows = `auto${" auto".repeat(lanes)} 1fr`;
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const column = String(i + 1);
      const outside = monthOf(date) !== month;
      const cell = el(doc, "div", "lp-day");
      cell.style.gridColumn = column;
      cell.style.gridRow = `1 / ${lanes + 3}`;
      if (outside) cell.classList.add("is-outside");
      if (date === current.today) cell.classList.add("is-today");
      if (studyDays.has(new Date(`${date}T00:00:00Z`).getUTCDay())) cell.classList.add("is-study");
      const number = el(doc, "div", "lp-day__number", String(Number(date.slice(8))));
      number.style.gridColumn = column;
      number.style.gridRow = "1";
      if (outside) number.classList.add("is-outside");
      if (date === current.today) number.classList.add("is-today");
      week.append(cell, number);
    }
    for (const bar of bars) {
      const node = bar.item.block ? blockChip(bar.item.entry, bar.item.block) : chip(bar.item.entry, bar.item.review!);
      node.classList.add("lp-bar");
      if (bar.fromPrev) node.classList.add("lp-bar--from-prev");
      if (bar.toNext) node.classList.add("lp-bar--to-next");
      node.style.gridColumn = `${bar.col + 1} / span ${bar.span}`;
      node.style.gridRow = String(bar.lane + 2);
      week.append(node);
    }
    return week;
  }

  function partsLabel(block: Block): string {
    if (block.of <= 1) return "";
    return block.firstPart === block.lastPart ? `${block.firstPart}/${block.of}` : `${block.firstPart}–${block.lastPart}/${block.of}`;
  }

  /** Chip text stays plain; the course colour comes from --lp-plan and done/overdue marks from CSS. */
  function blockChip(entry: PlanView, block: Block): HTMLElement {
    const button = el(doc, "button", `lp-chip lp-chip--${block.state}`);
    button.type = "button";
    colorize(button, entry);
    const title = findTopic(entry.plan, block.topicId)?.topic.title ?? block.topicId;
    const parts = partsLabel(block);
    button.textContent = parts ? `${title} (${parts})` : title;
    const range = block.start === block.end ? block.start : `${block.start} to ${block.end}`;
    button.title = `${planLabel(entry)}: ${button.textContent} · ${range}`;
    button.setAttribute("aria-label", `${STATE_LABEL[block.state]}: ${button.textContent}, ${range}, ${planLabel(entry)}`);
    button.addEventListener("click", () => openDetail(entry, blockSlot(block), block));
    return button;
  }

  function chip(entry: PlanView, slot: Slot): HTMLElement {
    const button = el(doc, "button", `lp-chip lp-chip--${slot.state} lp-chip--review`);
    button.type = "button";
    colorize(button, entry);
    button.textContent = "Review";
    button.title = `${planLabel(entry)}: review · ${slot.date}`;
    button.setAttribute("aria-label", `${STATE_LABEL[slot.state]}: review session, ${slot.date}, ${planLabel(entry)}`);
    button.addEventListener("click", () => openDetail(entry, slot));
    return button;
  }

  function openDetail(entry: PlanView, slot: Slot, block?: Block) {
    const plan = entry.plan!;
    const several = view ? planActive(view).length > 1 : false;
    const course = several ? ` · ${planLabel(entry)}` : "";
    let dialog: PluginWidgetHandle<unknown> | undefined;
    dialog = ctx.ui.openDialog({
      title: slot.kind === "review" ? "Review session" : "Topic",
      content: (dialogContainer, dialogSignal) => {
        const box = el(doc, "div", "lp-detail");
        dialogContainer.append(box);
        const local: PluginWidgetHandle<unknown>[] = [];
        if (slot.kind === "review") {
          box.append(el(doc, "h2", undefined, `Review · ${slot.date}${course}`));
          box.append(el(doc, "p", undefined, "A review session consolidates these recent topics. On its day, open a new Practice session and type “start today's topic”."));
          const list = el(doc, "ul");
          for (const id of slot.topicIds) list.append(el(doc, "li", undefined, findTopic(plan, id)?.topic.title ?? id));
          box.append(list);
        } else {
          const found = findTopic(plan, slot.topicId);
          if (!found) { box.append(el(doc, "p", undefined, "This topic is no longer in the plan.")); return () => box.remove(); }
          const { module, topic } = found;
          const when = block && block.start !== block.end
            ? `${block.start} to ${block.end}${topic.status === "done" ? "" : ` (due ${block.end})`}`
            : slot.date;
          box.append(el(doc, "h2", undefined, topic.title));
          box.append(el(doc, "p", "lp-hint", `${module.title}${course} · ${topic.id} · ${topic.sessions} session${topic.sessions === 1 ? "" : "s"} · ${when}${topic.status === "done" ? ` · done ${topic.completedAt ?? ""}` : ` · ${STATE_LABEL[slot.state]}`}`));
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
                if (!clipboard) throw new Error("Copying isn't available here.");
                await clipboard.writeText(brief(plan, slot, entry.profile, "teaching"));
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
    if (isDirty()) return;
    dirtyPlans.add(selected);
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

  function renderCurriculum(entry: PlanView) {
    const plan = entry.plan!;
    const dirty = isDirty();
    if (!edits.has(entry.id)) edits.set(entry.id, toEdit(plan));
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
      try { apply(await ctx.call<StateView>("revise", { planId: entry.id, request: request.value })); request.value = ""; }
      catch (failure) { reviseStatus.textContent = message(failure); }
    }, entry.draft?.status === "running" || dirty);
    reviseActions.append(reviseStatus);

    const editor = el(doc, "section", "lp-section");
    editor.append(el(doc, "h3", undefined, "Edit curriculum"));
    editor.append(el(doc, "p", "lp-hint", "Rename, reorder, add or remove topics and set how many sessions each needs. One objective per line. Save to reschedule."));
    const modules = edits.get(entry.id)!;
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
        const next = await ctx.call<StateView>("save-plan", { planId: entry.id, modules: payload });
        dirtyPlans.delete(entry.id);
        edits.delete(entry.id);
        apply(next);
      } catch (failure) { status.textContent = message(failure); }
    }, !dirty);
    const revertHandle = hostButton(actions, "Revert", "ghost", () => { dirtyPlans.delete(entry.id); edits.delete(entry.id); render(); }, !dirty);
    actions.append(status);
    dirtyControls = { save: saveHandle, revert: revertHandle, revise: reviseHandle, status };
    editor.append(addModule, actions);
    const manage = el(doc, "section", "lp-section");
    manage.append(el(doc, "h3", undefined, "Archive this plan"));
    manage.append(el(doc, "p", "lp-hint", "Hide it from the calendar and the teacher. Its progress and curriculum are kept; unarchive it any time in Settings."));
    const manageActions = el(doc, "div", "lp-actions");
    const manageStatus = el(doc, "span", "lp-hint");
    manage.append(manageActions);
    hostButton(manageActions, "Archive plan", "outline", async () => {
      try { apply(await ctx.call<StateView>("set-plan-archived", { planId: entry.id, archived: true })); }
      catch (failure) { manageStatus.textContent = message(failure); }
    });
    manageActions.append(manageStatus);
    body.append(reviseBox, editor, manage);
  }

  // ---- Render ----
  function render() {
    for (const widget of widgets.splice(0)) widget.dispose();
    dirtyControls = {};
    const current = view;
    if (!current) return;
    error.hidden = !current.loadError;
    error.textContent = current.loadError ?? "";
    renderDrafts(current);
    const plans = withCurriculum(current);
    if (!plans.length) { renderEmpty(current); return; }
    if (!plans.some(entry => entry.id === selected)) selected = plans[0]!.id;
    tabs.hidden = false;
    calendarTab.setAttribute("aria-selected", String(tab === "calendar"));
    curriculumTab.setAttribute("aria-selected", String(tab === "curriculum"));
    renderHeader(current);
    renderPlanTabs(current);
    body.replaceChildren();
    if (tab === "calendar") renderCalendar(current);
    else renderCurriculum(plans.find(entry => entry.id === selected)!);
  }

  function apply(next: StateView) {
    if (signal.aborted) return;
    const before = new Map((view?.plans ?? []).map(entry => [entry.id, JSON.stringify(entry.plan)]));
    view = next;
    for (const id of [...edits.keys()]) {
      const entry = next.plans.find(candidate => candidate.id === id);
      // Forget edits for courses that are gone or whose curriculum changed underneath them (and weren't being edited).
      if (!entry || (!dirtyPlans.has(id) && before.get(id) !== JSON.stringify(entry.plan))) edits.delete(id);
      if (!entry) dirtyPlans.delete(id);
    }
    // Keep in-progress edits stable: only re-render the editor when it is clean.
    if (tab === "curriculum" && isDirty()) { renderDrafts(next); return; }
    render();
  }

  subscribeState(ctx, signal, apply, failure => { error.hidden = false; error.textContent = message(failure); });

  return () => {
    for (const widget of widgets) widget.dispose();
    for (const panel of panels.values()) panel.dispose();
    panels.clear();
    root.remove();
  };
}
