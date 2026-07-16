// references:
// https://raw.githubusercontent.com/maximousblk/envoy/master/src/public/.well-known/deno-import-intellisense.json
// https://deno.land/.well-known/deno-import-intellisense.json
// https://intellisense.nest.land/deno-import-intellisense.json
// https://x.lcas.dev/.well-known/deno-import-intellisense.json
// https://crux.land/.well-known/deno-import-intellisense.json

import { Generations } from "../generations.ts";
import { Pattern, ResponseJson, RouteHandler } from "../helpers.ts";
import { SDK } from "../sdk-datasource.ts";

export const routeMap = new Map<string | URLPattern, RouteHandler>([

  ['/.well-known/deno-import-intellisense.json', ctx => lspConfig(ctx.requestUrl.origin)],

  ['/.completions/generations/list.json', () => {
    return ResponseJson(Array.from(Generations.keys()));
  }],

  ['/.completions/sdks/list.json', async () => {
    const versions = await SDK.getSdkVersions();
    return ResponseJson(versions.map(x => x.name));
  }],

  [Pattern('/.completions/generations/:genVer/modules/list.json'), async ctx => {
    const generation = Generations.get(ctx.params.genVer!);
    if (!generation) return ResponseJson([]);
    return ResponseJson(await listSdkModules(generation.sdkVersion));
  }],

  [Pattern('/.completions/sdks/:sdkVer/modules/list.json'), async ctx => {
    return ResponseJson(await listSdkModules(ctx.params.sdkVer!));
  }],

]);

async function listSdkModules(sdkVersion: string) {
  const sdk = new SDK(sdkVersion);
  const serviceDict = await sdk.getServiceList();

  const serviceList = Object.keys(serviceDict).sort();
  return serviceList.map(x => `${x}.ts`);
}

const lspConfig = (origin: string) => ResponseJson({
  "version": 1,
  "registries": [{
    "schema": "/:generation(v[0-9.]+)/sdk@:sdk(v[0-9.]+)/:module",
    "variables": [{
      "key": "generation",
      "url": `${origin}/.completions/generations/list.json`,
    },
    {
      "key": "sdk",
      "url": `${origin}/.completions/sdks/list.json`,
    },
    {
      "key": "module",
      "url": `${origin}/.completions/sdks/\${sdk}/modules/list.json`,
    }],
  },{
    "schema": "/:generation(v[0-9.]+)/services/:module",
    "variables": [{
      "key": "generation",
      "url": `${origin}/.completions/generations/list.json`,
    },
    {
      "key": "module",
      "url": `${origin}/.completions/generations/\${generation}/modules/list.json`,
    }],
  }],
})
