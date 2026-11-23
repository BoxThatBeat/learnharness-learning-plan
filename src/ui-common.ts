import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { entryName, type Draft, type Plan, type PlanEntry, type Profile } from "./plan-model.ts";
import type { Schedule } from "./schedule.ts";

/** One course as the frontend sees it. */
export type PlanView = {
  id: string;
  name: string;
  hue: number;
  archived: boolean;
  profile: Profile;
  plan: Plan | null;
  draft: Draft | null;
  progress?: { status: string; turns: number; activity?: string };
  schedule: Schedule;
};

export type StateView = {
  loadError: string | null;
  today: string;
  plans: PlanView[];
  /** Set by `add-plan`: the ID of the course just created. */
  created?: string;
};

export const planLabel = (entry: Pick<PlanEntry, "name" | "plan">): string => entryName(entry);
export const planActive = (view: StateView): PlanView[] => view.plans.filter(entry => !entry.archived);
/** The course colour. Saturation/lightness are fixed so every hue reads on light and dark themes. */
export const planColor = (hue: number): string => `hsl(${hue} 65% 52%)`;

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** How to start a planned topic. A brand-new session has no top bar (no session ID until the
 * first message), so the "Today's topic" button only exists once a session is under way. */
export function howToStart(doc: Document): HTMLElement {
  const box = el(doc, "div", "lp-howto");
  box.append(el(doc, "strong", undefined, "Starting a topic: "));
  box.append(doc.createTextNode("open a new Teaching or Practice session and type “start today's topic” (or “start t-12” for a specific one). The teacher picks it up and links the session to your calendar. In a session that's already under way, use the "));
  box.append(el(doc, "strong", undefined, "Today's topic"));
  box.append(doc.createTextNode(" button in its top bar instead."));
  return box;
}

/** Small native button for dense controls (move/delete); main actions use ctx.ui buttons. */
export function iconButton(doc: Document, label: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const button = el(doc, "button", "lp-icon-button", glyph);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

/** Re-fetch plugin state on notifications/resync; latest request wins. */
export function subscribeState(ctx: PluginFrontendContext, signal: AbortSignal, apply: (view: StateView) => void, onError: (error: unknown) => void): () => Promise<void> {
  let generation = 0;
  const refresh = async () => {
    const mine = ++generation;
    try {
      const view = await ctx.call<StateView>("get-state");
      if (mine === generation && !signal.aborted) apply(view);
    } catch (error) { if (!signal.aborted) onError(error); }
  };
  const offNotification = ctx.onNotification(event => {
    if (event.topic === "plan-changed" || event.topic === "draft-progress") void refresh();
  });
  const offResync = ctx.onResync(() => { void refresh(); });
  signal.addEventListener("abort", () => { generation++; offNotification(); offResync(); }, { once: true });
  void refresh();
  return refresh;
}

/** Draft status/preview with Accept/Discard; shared by Settings and the plan view. */
export class DraftPanel {
  readonly root: HTMLElement;
  private widgets: PluginWidgetHandle<unknown>[] = [];
  private key = "";

  constructor(private ctx: PluginFrontendContext, private signal: AbortSignal, private apply: (view: StateView) => void) {
    this.root = el(document, "div", "lp-draft");
    this.root.hidden = true;
  }

  private button(parent: HTMLElement, label: string, variant: "default" | "ghost" | "outline", onClick: () => Promise<void>) {
    this.widgets.push(this.ctx.ui.mountButton(parent, { label, variant, size: "sm", onClick }, { signal: this.signal }) as PluginWidgetHandle<unknown>);
  }

  /** `heading` names the course when several exist; `plan` is the course the draft belongs to. */
  update(plan: PlanView | undefined, heading = "") {
    const draft = plan?.draft;
    const key = plan && draft ? `${plan.id}:${heading}:${draft.requestId}:${draft.status}:${draft.status === "running" ? JSON.stringify(plan.progress ?? null) : ""}` : "";
    if (key === this.key) return;
    this.key = key;
    for (const widget of this.widgets) widget.dispose();
    this.widgets = [];
    this.root.replaceChildren();
    this.root.hidden = !draft;
    if (!plan || !draft) return;
    const doc = this.root.ownerDocument;
    const status = el(doc, "div", "lp-draft__status");
    status.setAttribute("role", "status");
    this.root.append(status);
    const actions = el(doc, "div", "lp-actions");
    const error = el(doc, "span", "lp-hint");
    const run = (operation: string) => async () => {
      error.textContent = "";
      try { this.apply(await this.ctx.call<StateView>(operation, { planId: plan.id })); } catch (failure) { error.textContent = message(failure); }
    };
    const prefix = heading ? `${heading}: ` : "";
    const verb = `${prefix}${draft.kind === "generate" ? "Generating your plan" : "Revising your plan"}`;
    if (draft.status === "running") {
      const progress = plan.progress;
      status.textContent = `${verb}… ${progress ? `(${progress.status}, step ${progress.turns}${progress.activity ? `: ${progress.activity}` : ""})` : ""} This can take a few minutes.`;
      this.root.append(actions);
      this.button(actions, "Cancel", "ghost", run("draft-discard"));
      actions.append(error);
      return;
    }
    if (draft.status === "failed") {
      status.textContent = `${verb} failed: ${draft.error}`;
      this.root.append(actions);
      this.button(actions, "Dismiss", "ghost", run("draft-discard"));
      actions.append(error);
      return;
    }
    const curriculum = draft.curriculum;
    const topics = curriculum.modules.flatMap(module => module.topics);
    const sessions = topics.reduce((sum, topic) => sum + topic.sessions, 0);
    const perWeek = Math.max(1, plan.profile.weekdays.length);
    status.textContent = `${prefix}Draft ready: "${curriculum.title}" — ${curriculum.modules.length} modules, ${topics.length} topics, ${sessions} sessions (≈ ${Math.ceil(sessions / perWeek)} weeks at ${perWeek}/week, before reviews).`;
    if (curriculum.summary) this.root.append(el(doc, "p", "lp-draft__summary", curriculum.summary));
    if (draft.kind === "revise") this.root.append(el(doc, "p", "lp-hint", "Completed topics stay as they are; this replaces the unfinished part."));
    const outline = el(doc, "ol", "lp-draft__outline");
    for (const module of curriculum.modules) {
      const item = el(doc, "li");
      item.append(el(doc, "strong", undefined, module.title));
      const list = el(doc, "ul");
      for (const topic of module.topics) list.append(el(doc, "li", undefined, `${topic.title} · ${topic.sessions} session${topic.sessions === 1 ? "" : "s"}`));
      item.append(list);
      outline.append(item);
    }
    this.root.append(outline);
    if (curriculum.sources.length) {
      const sources = el(doc, "details", "lp-draft__sources");
      sources.append(el(doc, "summary", undefined, `Sources (${curriculum.sources.length})`));
      const list = el(doc, "ul");
      for (const source of curriculum.sources) {
        const link = el(doc, "a", undefined, source.title);
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const item = el(doc, "li");
        item.append(link);
        list.append(item);
      }
      sources.append(list);
      this.root.append(sources);
    }
    this.root.append(actions);
    this.button(actions, draft.kind === "generate" ? "Accept plan" : "Accept revision", "default", run("draft-accept"));
    this.button(actions, "Discard", "ghost", run("draft-discard"));
    actions.append(error);
  }

  dispose() {
    for (const widget of this.widgets) widget.dispose();
    this.widgets = [];
    this.root.remove();
  }
}
