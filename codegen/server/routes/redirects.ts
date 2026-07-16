import { LatestGeneration } from "../generations.ts";
import { Pattern, ResponseRedirect, RouteHandler } from "../helpers.ts";

export const routeMap = new Map<string | URLPattern, RouteHandler>([

  ['/', () =>
    ResponseRedirect(`/${LatestGeneration}/services/`)],

  [Pattern('/:genVer(v[0-9.]+){/}?'), ctx =>
    ResponseRedirect(`/${ctx.params.genVer}/services/`)],

  // This one can be used in imports so we attach a warning header for Deno CLI
  [Pattern('/latest/:rest(.*)?'), ctx => {
    return ResponseRedirect(`/${LatestGeneration}/${ctx.params.rest}${ctx.requestUrl.search}`, {
      'x-deno-warning': `Using latest revision (${LatestGeneration}) of the aws-api codegen`,
    });
  }],

]);
