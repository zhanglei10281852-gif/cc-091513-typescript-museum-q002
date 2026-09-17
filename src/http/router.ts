import type { Principal, Role } from "../domain/types.js";

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  principal: Principal;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

interface Route {
  method: string;
  segments: string[];
  /** null 表示只读接口，任何角色（含匿名）可访问 */
  roles: Role[] | null;
  handler: RouteHandler;
}

/** 极简路由器：支持 :param 路径参数，静态段优先于参数段。 */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, roles: Role[] | null, handler: RouteHandler): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), roles, handler });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const segments = path.split("/").filter(Boolean);
    const candidates = [...this.routes].sort((a, b) => staticCount(b) - staticCount(a));
    for (const route of candidates) {
      if (route.method !== method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segments.length; i += 1) {
        const patternSeg = route.segments[i];
        const actualSeg = segments[i];
        if (patternSeg === undefined || actualSeg === undefined) {
          ok = false;
          break;
        }
        if (patternSeg.startsWith(":")) {
          params[patternSeg.slice(1)] = decodeURIComponent(actualSeg);
        } else if (patternSeg !== actualSeg) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

function staticCount(route: Route): number {
  return route.segments.filter((s) => !s.startsWith(":")).length;
}
