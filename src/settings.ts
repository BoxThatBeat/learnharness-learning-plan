import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { Profile } from "./plan-model.ts";
import { DraftPanel, el, message, subscribeState, type StateView } from "./ui-common.ts";

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
  let profileDirty = false;

  const error = el(doc, "p", "lp-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  root.append(error);

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
  root.append(schedule);
  const saveSchedule = button(scheduleActions, {
    label: "Save schedule", size: "sm", disabled: true,
    onClick: async () => {
      scheduleStatus.textContent = "";
      try {
        const profile: Omit<Profile, "modelOverride"> = {
          weekdays: [...dayBoxes].filter(([, box]) => box.checked).map(([day]) => day),
          minutesPerSession: Number(minutes.value),
          startDate: start.value,
          reviewEvery: review.value === "" ? 0 : Number(review.value),
          behindMode: behind.value as Profile["behindMode"],
          targetWeeks: weeks.value === "" ? null : Number(weeks.value),
          goalPrompt: view?.profile.goalPrompt ?? "",
        };
        if (!profile.weekdays.length) throw new Error("Tick at least one study day.");
        const next = await ctx.call<StateView>("save-profile", { profile });
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
  planner.append(el(doc, "p", "lp-hint", "Describe your background and what you want to become. The planner draws on how good universities structure the field, may read public syllabus pages, and returns a curriculum for you to review. One run is a multi-step model task and may cost noticeably more than a chat turn."));
  const modelRow = el(doc, "div", "lp-model");
  const pickerSlot = el(doc, "span");
  const modelHint = el(doc, "span", "lp-hint");
  modelRow.append(el(doc, "span", "lp-label", "Planning model"), pickerSlot, modelHint);
  const picker = ctx.ui.mountModelPicker(pickerSlot, {
    value: undefined,
    onChange: async value => { apply(await ctx.call<StateView>("set-model-override", { model: value })); },
  }, { signal });
  widgets.push(picker as PluginWidgetHandle<unknown>);
  const reset = button(modelRow, { label: "Use strong slot", variant: "ghost", size: "xs", onClick: async () => { apply(await ctx.call<StateView>("set-model-override", { model: null })); } });
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
  root.append(planner);

  async function generate() {
    plannerStatus.textContent = "";
    try {
      if (profileDirty) throw new Error("Save your schedule first so the plan is sized to it.");
      apply(await ctx.call<StateView>("generate", { goal: goal.value }));
      goalDirty = false;
    } catch (failure) { plannerStatus.textContent = message(failure); }
  }
  const generateButton = button(plannerActions, {
    label: "Generate plan", size: "sm",
    onClick: async () => {
      if (!view?.plan) return generate();
      // Replacing an existing plan loses its progress: confirm first.
      let dialog: PluginWidgetHandle<unknown> | undefined;
      dialog = ctx.ui.openDialog({
        title: "Replace your plan?",
        content: (box, dialogSignal) => {
          const wrap = el(doc, "div", "lp-confirm");
          box.append(wrap);
          wrap.append(el(doc, "h2", undefined, "Replace your plan?"));
          wrap.append(el(doc, "p", undefined, `A new plan replaces "${view?.plan?.title}" and its progress once you accept the draft. Your current plan stays until then. To keep progress, use "Revise with AI" in the Learning plan view instead.`));
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

  // ---- Apply state ----
  function apply(next: StateView) {
    if (signal.aborted) return;
    view = next;
    error.hidden = !next.loadError;
    error.textContent = next.loadError ?? "";
    if (!profileDirty) {
      const profile = next.profile;
      for (const [day, box] of dayBoxes) box.checked = profile.weekdays.includes(day);
      minutes.value = String(profile.minutesPerSession);
      start.value = profile.startDate;
      review.value = String(profile.reviewEvery);
      behind.value = profile.behindMode;
      weeks.value = profile.targetWeeks === null ? "" : String(profile.targetWeeks);
      saveSchedule.update({ disabled: true });
    }
    if (!goalDirty) goal.value = next.profile.goalPrompt;
    picker.update({ value: next.profile.modelOverride ?? undefined });
    modelHint.textContent = next.profile.modelOverride ? "" : "Using the strong model slot.";
    reset.update({ disabled: !next.profile.modelOverride });
    const running = next.draft?.status === "running";
    generateButton.update({ label: next.plan ? "Regenerate plan" : "Generate plan", disabled: running || Boolean(next.loadError) });
    openPlan.update({ disabled: !next.plan });
    draft.update(next);
  }

  subscribeState(ctx, signal, apply, failure => { error.hidden = false; error.textContent = message(failure); });

  return () => {
    for (const widget of widgets) widget.dispose();
    draft.dispose();
    root.remove();
  };
}
