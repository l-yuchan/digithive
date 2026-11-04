import type { CapabilitiesResponse, Settings } from "../shared/types";

export type Route = "today" | "calendar" | "entries" | "sources" | "review" | "evaluation" | "settings" | "history";

export interface ViewContext {
  capabilities: CapabilitiesResponse | null;
  settings: Settings | null;
  refresh: () => Promise<void>;
  navigate: (route: Route) => void;
  notify: (message: string) => void;
}

export type View = (container: HTMLElement, context: ViewContext) => Promise<void>;
