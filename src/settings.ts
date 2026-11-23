import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { Profile } from "./plan-model.ts";
import { DraftPanel, el, message, planColor, planLabel, subscribeState, type PlanView, type StateView } from "./ui-common.ts";

const SPINNER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M12 3a9 9 0 0 1 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>';

const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]] as const;

export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): () => void {
  const doc = container.ownerDocument;
  const root = el(doc, "div", "lp-settings");
  container.append(root);
  const widgets: PluginWidgetHandle<unknown>[] = [];
  const button = (parent: HTMLElement, props: Parameters<PluginFrontendContext["ui"]["mountButton"]>[1]) => {
    const handle = ctx.ui.mountButton(parent, props, { signal });
    widgets.push(handle as PluginWidgetHandle<unknown>);
    return handle;
  };
  let view: StateView | null = null;
  /** The course whose settings are shown. */
  let selected = "";
  /** Which course the form fields currently hold, so switching courses reloads them. */
  let loadedFor = "";
  let profileDirty = false;
  const current = (): PlanView | undefined => view?.plans.find(entry => entry.id === selected);

  const error = el(doc, "p", "lp-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  root.append(error);

  // ---- Plans ----
  const plansBox = el(doc, "section", "lp-section");
  plansBox.append(el(doc, "h3", undefined, "Plans"));
  plansBox.append(el(doc, "p", "lp-hint", "Each plan is a separate course with its own schedule, goal and curriculum. All active plans appear together in the calendar. Archiving hides a plan but keeps its progress."));
  const planTabs = el(doc, "div", "lp-tabs lp-tabs--plans");
  planTabs.setAttribute("role", "tablist");
  planTabs.setAttribute("aria-label", "Plans");
  const planActions = el(doc, "div", "lp-actions");
  const planStatus = el(doc, "span", "lp-hint");
  planStatus.setAttribute("role", "status");
  const emptyNote = el(doc, "p", undefined, "You have no plans yet. Add one to set its schedule and generate a curriculum.");
  plansBox.append(emptyNote, planTabs, planActions);
  root.append(plansBox);
  const detail = el(doc, "div", "lp-settings__plan");
  root.append(detail);
  const nameRow = el(doc, "label", "lp-field lp-field--name");
  const nameInput = el(doc, "input", "lp-input");
  nameInput.maxLength = 80;
  nameInput.setAttribute("aria-label", "Plan name");
  nameRow.append(el(doc, "span", "lp-label", "Plan name"), nameInput);
  detail.append(nameRow);
  const archivedNote = el(doc, "p", "lp-warning", "This plan is archived: hidden from the calendar and the teacher. Unarchive it to generate or revise.");
  archivedNote.hidden = true;
  detail.append(archivedNote);
  nameInput.addEventListener("change", async () => {
    const entry = current();
    if (!entry) return;
    try { apply(await ctx.call<StateView>("rename-plan", { planId: entry.id, name: nameInput.value })); planStatus.textContent = ""; }
    catch (failure) { planStatus.textContent = message(failure); }
  });

  // ---- Schedule ----
  const schedule = el(doc, "section", "lp-section");
  schedule.append(el(doc, "h3", undefined, "Schedule"));
  schedule.append(el(doc, "p", "lp-hint", "Sessions per week = the number of study days you tick. Changing these reschedules the calendar instantly; no model call."));
  const form = el(doc, "div", "lp-form");
  const field = (label: string, input: HTMLElement, hint?: string) => {
    const wrap = el(doc, "label", "lp-field");
    wrap.append(el(doc, "span", "lp-label", label), input);
    if (hint) wrap.append(el(doc, "span", "lp-hint", hint));
    form.append(wrap);
  };
  const dayBoxes = new Map<number, HTMLInputElement>();
  const days = el(doc, "div", "lp-days");
  days.setAttribute("role", "group");
  days.setAttribute("aria-label", "Study days");
  for (const [value, name] of DAYS) {
    const label = el(doc, "label", "lp-day-toggle");
    const box = el(doc, "input");
    box.type = "checkbox";
    box.addEventListener("change", touched);
    label.append(box, el(doc, "span", undefined, name));
    days.append(label);
    dayBoxes.set(value, box);
  }
  const daysWrap = el(doc, "div", "lp-field");
  daysWrap.append(el(doc, "span", "lp-label", "Study days"), days);
  form.append(daysWrap);
  const number = (min: number, max: number) => {
    const input = el(doc, "input", "lp-input lp-input--short");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.addEventListener("input", touched);
    return input;
  };
  const minutes = number(10, 600);
  field("Minutes per session", minutes);
  const start = el(doc, "input", "lp-input lp-input--short");
  start.type = "date";
  start.addEventListener("input", touched);
  field("Start date", start, "Fixed-date schedules count from here.");
  const review = number(0, 20);
  field("Review every Nth session", review, "0 turns review sessions off.");
  const behind = el(doc, "select", "lp-input lp-input--short");
  for (const [value, label] of [["shift", "Auto-shift unfinished topics forward"], ["fixed", "Keep dates; show overdue topics"]] as const) {
    const option = el(doc, "option", undefined, label);
    option.value = value;
    behind.append(option);
  }
  behind.addEventListener("change", touched);
  field("When I fall behind", behind);
  const weeks = number(1, 520);
  weeks.placeholder = "optional";
  field("Target length (weeks)", weeks, "Used when generating or revising; leave blank to let the planner size it.");
  const scheduleActions = el(doc, "div", "lp-actions");
  const scheduleStatus = el(doc, "span", "lp-hint");
  scheduleStatus.setAttribute("role", "status");
  schedule.append(form, scheduleActions);
  detail.append(schedule);
  const saveSchedule = button(scheduleActions, {
    label: "Save schedule", size: "sm", disabled: true,
    onClick: async () => {
      scheduleStatus.textContent = "";
      try {
        const entry = current();
        if (!entry) return;
        const profile: Omit<Profile, "modelOverride"> = {
          weekdays: [...dayBoxes].filter(([, box]) => box.checked).map(([day]) => day),
          minutesPerSession: Number(minutes.value),
          startDate: start.value,
          reviewEvery: review.value === "" ? 0 : Number(review.value),
          behindMode: behind.value as Profile["behindMode"],
          targetWeeks: weeks.value === "" ? null : Number(weeks.value),
          goalPrompt: entry.profile.goalPrompt,
        };
        if (!profile.weekdays.length) throw new Error("Tick at least one study day.");
        const next = await ctx.call<StateView>("save-profile", { planId: entry.id, profile });
        profileDirty = false;
        apply(next);
        scheduleStatus.textContent = "Saved.";
      } catch (failure) { scheduleStatus.textContent = message(failure); }
    },
  });
  scheduleActions.append(scheduleStatus);
  function touched() {
    profileDirty = true;
    saveSchedule.update({ disabled: false });
    scheduleStatus.textContent = "Unsaved changes.";
  }

  // ---- Planner ----
  const planner = el(doc, "section", "lp-section");
  planner.append(el(doc, "h3", undefined, "Goal and plan"));
  planner.append(el(doc, "p", "lp-hint", "Describe your background and what you want to become. The planner draws on how good universities structure the field, may read public syllabus pages, and returns a curriculum for you to review."));
  const modelRow = el(doc, "div", "lp-model");
  const pickerSlot = el(doc, "span");
  const modelHint = el(doc, "span", "lp-hint");
  modelRow.append(el(doc, "span", "lp-label", "Planning model"), pickerSlot, modelHint);
  const picker = ctx.ui.mountModelPicker(pickerSlot, {
    value: undefined,
    onChange: async value => { const entry = current(); if (entry) apply(await ctx.call<StateView>("set-model-override", { planId: entry.id, model: value })); },
  }, { signal });
  widgets.push(picker as PluginWidgetHandle<unknown>);
  const reset = button(modelRow, { label: "Use strong slot", variant: "ghost", size: "xs", onClick: async () => { const entry = current(); if (entry) apply(await ctx.call<StateView>("set-model-override", { planId: entry.id, model: null })); } });
  const goal = el(doc, "textarea", "lp-input lp-textarea");
  goal.rows = 6;
  goal.placeholder = "e.g. I have a computer science degree and a math minor. I now want to become a mix between an electrical engineer and a mechatronics engineer, focusing on electronic circuits and radio communication. Research what syllabuses at good universities include and make me a learning plan.";
  goal.setAttribute("aria-label", "Background and goal");
  let goalDirty = false;
  goal.addEventListener("input", () => { goalDirty = true; });
  const plannerActions = el(doc, "div", "lp-actions");
  const plannerStatus = el(doc, "span", "lp-hint");
  plannerStatus.setAttribute("role", "status");
  const draft = new DraftPanel(ctx, signal, next => apply(next));
  planner.append(modelRow, goal, plannerActions, draft.root);
  detail.append(planner);

  /** True from the click until the server's reply shows the draft running. */
  let starting = false;
  function paintGenerate() {
    const entry = current();
    const draftRunning = entry?.draft?.status === "running";
    const busy = starting || draftRunning;
    const revising = draftRunning && entry?.draft?.kind !== "generate";
    generateButton.update(busy
      ? { label: revising ? "Revising plan" : "Generating plan", icon: SPINNER_ICON, disabled: true }
      : { label: entry?.plan ? "Regenerate plan" : "Generate plan", icon: undefined, disabled: !entry || entry.archived || Boolean(view?.loadError) });
  }
  async function generate() {
    plannerStatus.textContent = "";
    starting = true;
    paintGenerate();
    try {
      const entry = current();
      if (!entry) return;
      if (profileDirty) throw new Error("Save your schedule first so the plan is sized to it.");
      apply(await ctx.call<StateView>("generate", { planId: entry.id, goal: goal.value }));
      goalDirty = false;
    } catch (failure) { plannerStatus.textContent = message(failure); } finally { starting = false; paintGenerate(); }
  }
  const generateButton = button(plannerActions, {
    label: "Generate plan", size: "sm",
    onClick: async () => {
      if (!current()?.plan) return generate();
      // Replacing an existing plan loses its progress: confirm first.
      let dialog: PluginWidgetHandle<unknown> | undefined;
      dialog = ctx.ui.openDialog({
        title: "Replace your plan?",
        content: (box, dialogSignal) => {
          const wrap = el(doc, "div", "lp-confirm");
          box.append(wrap);
          wrap.append(el(doc, "h2", undefined, "Replace your plan?"));
          wrap.append(el(doc, "p", undefined, `A new plan replaces "${current()?.plan?.title}" and its progress once you accept the draft. Your current plan stays until then. To keep progress, use "Revise with AI" in the Learning plan view instead.`));
          const actions = el(doc, "div", "lp-actions");
          wrap.append(actions);
          const local = [
            ctx.ui.mountButton(actions, { label: "Generate new plan", variant: "destructive", size: "sm", onClick: async () => { dialog?.dispose(); await generate(); } }, { signal: dialogSignal }),
            ctx.ui.mountButton(actions, { label: "Cancel", variant: "ghost", size: "sm", onClick: () => dialog?.dispose() }, { signal: dialogSignal }),
          ];
          return () => { for (const widget of local) widget.dispose(); wrap.remove(); };
        },
      }, { signal }) as PluginWidgetHandle<unknown>;
    },
  });
  const openPlan = button(plannerActions, { label: "Open calendar", variant: "outline", size: "sm", onClick: () => ctx.app.openView("calendar") });
  plannerActions.append(plannerStatus);

  // ---- Plan management ----
  const swatch = (entry: PlanView) => {
    const dot = el(doc, "span", "lp-swatch");
    dot.style.setProperty("--lp-plan", planColor(entry.hue));
    return dot;
  };
  function select(id: string) {
    selected = id;
    if (view) apply(view);
  }
  const addPlan = button(planActions, {
    label: "Add plan", size: "sm", variant: "outline",
    onClick: async () => {
      planStatus.textContent = "";
      try {
        const next = await ctx.call<StateView>("add-plan");
        selected = next.created ?? selected;
        apply(next);
      } catch (failure) { planStatus.textContent = message(failure); }
    },
  });
  const archivePlan = button(planActions, {
    label: "Archive plan", size: "sm", variant: "outline",
    onClick: async () => {
      const entry = current();
      if (!entry) return;
      planStatus.textContent = "";
      try { apply(await ctx.call<StateView>("set-plan-archived", { planId: entry.id, archived: !entry.archived })); }
      catch (failure) { planStatus.textContent = message(failure); }
    },
  });
  const removePlan = button(planActions, {
    label: "Remove plan", size: "sm", variant: "destructive",
    onClick: () => {
      const entry = current();
      if (!entry) return;
      let dialog: PluginWidgetHandle<unknown> | undefined;
      dialog = ctx.ui.openDialog({
        title: "Remove plan?",
        content: (box, dialogSignal) => {
          const wrap = el(doc, "div", "lp-confirm");
          box.append(wrap);
          wrap.append(el(doc, "h2", undefined, `Remove "${planLabel(entry)}"?`));
          wrap.append(el(doc, "p", undefined, "This permanently deletes the plan's curriculum, progress and settings. Archive it instead to hide it but keep everything."));
          const actions = el(doc, "div", "lp-actions");
          wrap.append(actions);
          const local = [
            ctx.ui.mountButton(actions, {
              label: "Remove plan", variant: "destructive", size: "sm",
              onClick: async () => {
                dialog?.dispose();
                planStatus.textContent = "";
                try { apply(await ctx.call<StateView>("remove-plan", { planId: entry.id })); }
                catch (failure) { planStatus.textContent = message(failure); }
              },
            }, { signal: dialogSignal }),
            ...(entry.archived ? [] : [ctx.ui.mountButton(actions, {
              label: "Archive instead", variant: "outline", size: "sm",
              onClick: async () => {
                dialog?.dispose();
                try { apply(await ctx.call<StateView>("set-plan-archived", { planId: entry.id, archived: true })); }
                catch (failure) { planStatus.textContent = message(failure); }
              },
            }, { signal: dialogSignal })]),
            ctx.ui.mountButton(actions, { label: "Cancel", variant: "ghost", size: "sm", onClick: () => dialog?.dispose() }, { signal: dialogSignal }),
          ];
          return () => { for (const widget of local) widget.dispose(); wrap.remove(); };
        },
      }, { signal }) as PluginWidgetHandle<unknown>;
    },
  });
  planActions.append(planStatus);

  // ---- Apply state ----
  function apply(next: StateView) {
    if (signal.aborted) return;
    view = next;
    error.hidden = !next.loadError;
    error.textContent = next.loadError ?? "";
    if (!next.plans.some(entry => entry.id === selected)) selected = next.plans[0]?.id ?? "";
    const entry = current();

    planTabs.replaceChildren();
    for (const candidate of next.plans) {
      const tab = el(doc, "button", "lp-tab lp-tab--plan");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(candidate.id === selected));
      tab.append(swatch(candidate), doc.createTextNode(planLabel(candidate)));
      if (candidate.archived) tab.append(el(doc, "span", "lp-hint", " (archived)"));
      tab.addEventListener("click", () => { if (candidate.id !== selected) select(candidate.id); });
      planTabs.append(tab);
    }
    planTabs.hidden = !next.plans.length;
    emptyNote.hidden = next.plans.length > 0;
    archivePlan.update({ label: entry?.archived ? "Unarchive plan" : "Archive plan", disabled: !entry });
    removePlan.update({ disabled: !entry });
    detail.hidden = !entry;
    if (!entry) { draft.update(undefined); return; }
    archivedNote.hidden = !entry.archived;

    if (loadedFor !== entry.id) { loadedFor = entry.id; profileDirty = false; goalDirty = false; }
    if (!profileDirty) {
      const profile = entry.profile;
      for (const [day, box] of dayBoxes) box.checked = profile.weekdays.includes(day);
      minutes.value = String(profile.minutesPerSession);
      start.value = profile.startDate;
      review.value = String(profile.reviewEvery);
      behind.value = profile.behindMode;
      weeks.value = profile.targetWeeks === null ? "" : String(profile.targetWeeks);
      saveSchedule.update({ disabled: true });
      scheduleStatus.textContent = "";
    }
    if (doc.activeElement !== nameInput) nameInput.value = entry.name;
    nameInput.placeholder = entry.plan?.title ?? "Untitled plan";
    if (!goalDirty) goal.value = entry.profile.goalPrompt;
    picker.update({ value: entry.profile.modelOverride ?? undefined });
    modelHint.textContent = entry.profile.modelOverride ? "" : "Using the strong model slot.";
    reset.update({ disabled: !entry.profile.modelOverride });
    paintGenerate();
    openPlan.update({ disabled: !entry.plan || entry.archived });
    draft.update(entry);
  }

  subscribeState(ctx, signal, apply, failure => { error.hidden = false; error.textContent = message(failure); });

  return () => {
    for (const widget of widgets) widget.dispose();
    draft.dispose();
    root.remove();
  };
}
