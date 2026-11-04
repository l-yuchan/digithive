import type { CtxDeps, CompiledRoute, Route } from "./api_util";
import { errorResponse, jsonReply } from "./api_util";
import { entryRoutes } from "./api/entries";
import { recordRoutes } from "./api/records";
import { assistRoutes } from "./api/assist";
import { systemRoutes } from "./api/system";
import { evaluationRoutes } from "./api/evaluation";
import { calendarRoutes } from "./api/calendar";

// JSON API router (contract §7). Routes are matched by method + path pattern
// (`:param` segments); unknown /api paths answer 404 not_found.

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path.replace(/:[A-Za-z_]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  });
  return { ...route, keys, re: new RegExp(`^${pattern}$`) };
}

const ROUTES: CompiledRoute[] = [
  ...systemRoutes,
  ...entryRoutes,
  ...recordRoutes,
  ...assistRoutes,
  ...evaluationRoutes,
  ...calendarRoutes,
].map(compile);

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function createApi(deps: CtxDeps) {
  return {
    routes: ROUTES,
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = normalizePath(url.pathname);
      for (const route of ROUTES) {
        if (route.method !== req.method) continue;
        const match = route.re.exec(path);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1] ?? "");
        });
        try {
          const reply = await route.handler({ ...deps, url, params, req });
          if (reply instanceof Response) return reply;
          return jsonReply(reply.status ?? 200, reply.body ?? null);
        } catch (e) {
          return errorResponse(e);
        }
      }
      return jsonReply(404, {
        error: { code: "not_found", message: `no route for ${req.method} ${path}` },
      });
    },
  };
}
