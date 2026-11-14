import type { PluginFrontendContext } from "learnharness-plugin-api";
import { setupKickoff } from "./kickoff.ts";
import { mountSettings } from "./settings.ts";
import { mountPlanView } from "./view.ts";

const SIDEBAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 15l2 2 4-4"/></svg>';

export function activate(ctx: PluginFrontendContext): () => void {
  const registrations: (() => void)[] = [];
  registrations.push(ctx.registerView({ id: "calendar", name: "Learning plan", mount: (container, signal) => mountPlanView(ctx, container, signal) }));
  registrations.push(ctx.registerAction({ id: "open", name: "Learning plan", icon: SIDEBAR_ICON, run: () => ctx.app.openView("calendar") }));
  registrations.push(ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" }));
  registrations.push(ctx.registerSettings((container: HTMLElement, signal: AbortSignal) => mountSettings(ctx, container, signal)));
  registrations.push(setupKickoff(ctx, () => ctx.app.openView("calendar")));
  return () => {
    for (const unregister of registrations.reverse()) {
      try { unregister(); } catch { /* Continue releasing. */ }
    }
  };
}
