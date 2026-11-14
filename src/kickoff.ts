import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { allTopics, findTopic } from "./plan-model.ts";
import { brief, slotForTopic, type Slot } from "./schedule.ts";
import { el, message, type StateView } from "./ui-common.ts";

type Armed = { topicId: string | null; brief: string };

const CALENDAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01"/></svg>';

/** "Today's topic" top-bar action + the interceptor that prepends the chosen brief to the
 * learner's next message in that session. Attached briefs live only in this window's memory. */
export function setupKickoff(ctx: PluginFrontendContext, openPlan: () => void): () => void {
  const armed = new Map<string, Armed>();

  const unregisterInterceptor = ctx.registerSubmissionInterceptor({
    id: "learning-plan-kickoff",
    hasPendingInput: target => target.type === "text" && armed.has(target.sessionId),
    intercept(input, context) {
      if (input.type !== "text" || context.type !== "text") return undefined;
      const entry = armed.get(context.sessionId);
      if (!entry) return undefined;
      const sessionId = context.sessionId;
      context.onAccepted(async () => {
        // Clear only after the host acknowledged the message; a refused send keeps it attached.
        if (armed.get(sessionId) === entry) {
          armed.delete(sessionId);
          ctx.refreshSubmissions();
        }
        if (entry.topicId) await ctx.call("link-session", { topicId: entry.topicId, sessionId });
      });
      const typed = input.content.text;
      return { type: "text", content: { text: /\S/.test(typed) ? `${entry.brief}\n\n${typed}` : entry.brief, images: input.content.images } };
    },
  });

  function openDialog(sessionId: string, kind: "teaching" | "practice") {
    let dialog: PluginWidgetHandle<unknown> | undefined;
    const close = () => dialog?.dispose();
    dialog = ctx.ui.openDialog({
      title: "Today's topic",
      content: (container, signal) => {
        const doc = container.ownerDocument;
        const root = el(doc, "div", "lp-kickoff");
        container.append(root);
        root.append(el(doc, "h2", "lp-kickoff__title", "Today's topic"));
        const body = el(doc, "div");
        root.append(body);
        const widgets: PluginWidgetHandle<unknown>[] = [];
        const button = (parent: HTMLElement, label: string, variant: "default" | "ghost" | "outline", onClick: () => void | Promise<void>) =>
          widgets.push(ctx.ui.mountButton(parent, { label, variant, size: "sm", onClick }, { signal }) as PluginWidgetHandle<unknown>);
        body.append(el(doc, "p", "lp-hint", "Loading your plan…"));
        void ctx.call<StateView>("get-state").then(view => {
          if (signal.aborted) return;
          body.replaceChildren();
          const plan = view.plan;
          if (!plan) {
            body.append(el(doc, "p", undefined, "You don't have a learning plan yet. Create one in the Learning plan settings."));
            const actions = el(doc, "div", "lp-actions");
            body.append(actions);
            button(actions, "Open Learning plan", "default", () => { close(); openPlan(); });
            return;
          }
          const current = view.schedule.current;
          const options: { value: string; label: string; slot: () => Slot | null }[] = [];
          if (current) {
            const label = current.kind === "review"
              ? `Scheduled ${current.date}: review session`
              : `Scheduled ${current.date}${current.state === "overdue" ? " (overdue)" : ""}: ${findTopic(plan, current.topicId)?.topic.title ?? current.topicId}`;
            options.push({ value: "current", label, slot: () => current.kind === "review" ? current : slotForTopic(plan, current.topicId, view.today) });
          }
          for (const topic of allTopics(plan).filter(candidate => candidate.status !== "done")) {
            options.push({ value: topic.id, label: `${topic.id} — ${topic.title}`, slot: () => slotForTopic(plan, topic.id, view.today) });
          }
          if (!options.length) {
            body.append(el(doc, "p", undefined, "Every topic in your plan is done. Revise the plan to add more."));
            return;
          }
          const label = el(doc, "label", "lp-label", "Start");
          const select = el(doc, "select", "lp-input");
          select.id = "lp-kickoff-choice";
          label.htmlFor = select.id;
          for (const option of options) {
            const node = el(doc, "option", undefined, option.label);
            node.value = option.value;
            select.append(node);
          }
          const preview = el(doc, "pre", "lp-kickoff__brief");
          const status = el(doc, "p", "lp-hint");
          status.setAttribute("role", "status");
          const chosen = () => {
            const slot = options.find(option => option.value === select.value)?.slot() ?? null;
            return slot ? { slot, text: brief(plan, slot, view.profile, kind) } : null;
          };
          const render = () => { preview.textContent = chosen()?.text ?? ""; };
          select.addEventListener("change", render);
          render();
          const existing = armed.get(sessionId);
          if (existing) status.textContent = "A plan topic is already attached to your next message in this session. Attaching again replaces it.";
          body.append(label, select, el(doc, "div", "lp-label", "This will be added to the start of your next message:"), preview, status);
          const actions = el(doc, "div", "lp-actions");
          body.append(actions);
          button(actions, "Attach to my next message", "default", () => {
            const pick = chosen();
            if (!pick) return;
            armed.set(sessionId, { topicId: pick.slot.kind === "topic" ? pick.slot.topicId : null, brief: pick.text });
            ctx.refreshSubmissions();
            close();
          });
          if (existing) button(actions, "Detach", "outline", () => { armed.delete(sessionId); ctx.refreshSubmissions(); close(); });
          button(actions, "Cancel", "ghost", close);
          body.append(el(doc, "p", "lp-hint", "Then send a message (even just “go”) to start. The session is linked to the topic in your calendar."));
          body.append(el(doc, "p", "lp-hint", "Tip: in a brand-new session this button isn't shown yet. Type “start today's topic” as your first message instead."));
        }).catch(error => {
          if (signal.aborted) return;
          body.replaceChildren(el(doc, "p", "lp-error", message(error)));
        });
        return () => { for (const widget of widgets) widget.dispose(); root.remove(); };
      },
    }, { signal: ctx.signal }) as PluginWidgetHandle<unknown>;
  }

  const unregisterAction = ctx.registerAction({
    id: "todays-topic",
    name: "Today's topic",
    icon: CALENDAR_ICON,
    run: context => {
      if (context.surface !== "session") return;
      openDialog(context.sessionId, context.kind);
    },
  });
  const unplace = ctx.placeAction({ id: "todays-topic-top-bar", actionId: "todays-topic", location: "top-bar", sessions: ["teaching", "practice"] });

  return () => {
    try { unplace(); } finally { try { unregisterAction(); } finally { unregisterInterceptor(); armed.clear(); } }
  };
}
