import { SDK } from "../sdk-datasource.ts";
import { Generations, ModuleGenerator } from "../generations.ts";
import { ClientError, escapeTemplate, getModuleIdentity, jsonTemplate, Pattern, ResponseRedirect, ResponseText, RouteHandler, acceptsHtml } from "../helpers.ts";

const handleRequest: RouteHandler = ctx => {
  const {genVer, sdkVer} = ctx.params;
  const {selfUrl, params} = getModuleIdentity(ctx.requestUrl);
  return renderUnifiedModule({
    genVer: genVer!,
    sdkVer,
    params,
    wantsHtml: acceptsHtml(ctx.headers),
  });
};
export const routeMap = new Map<string | URLPattern, RouteHandler>([
  [Pattern(`/:genVer(v[0-9.]+)/sdk@:sdkVer(v2\\.[0-9.]+)/mod.ts`), handleRequest],
  [Pattern(`/:genVer(v[0-9.]+)/services/mod.ts`), handleRequest],
]);

export async function renderUnifiedModule(props: {
  genVer: string;
  sdkVer?: string;
  // service: string;
  // svcVer: string;
  wantsHtml: boolean;
  params: URLSearchParams,
  // selfUrl: string;
}) {
  const generation = Generations.get(props.genVer);
  if (!generation) return ResponseText(404,
    `Codegen version '${props.genVer}' not found.\nKnown versions: ${Array.from(Generations.keys()).join(', ')}`);

  const sdkVersion = props.sdkVer || generation.sdkVersion;

  const mutualProps = new URLSearchParams();
  const services = new Map<string, URLSearchParams>();

  for (const [k, v] of props.params) {
    const match = k.match(/^([^.\[\]]+)\[([^\]]+)\]$/);
    if (match) {
      const [_, subKey, serviceId] = match;
      let service = services.get(serviceId);
      if (!service) {
        service = new URLSearchParams();
        services.set(serviceId, service);
      }
      service.append(subKey, v);
    } else {
      mutualProps.append(k, v);
    }
  }

  const fullMutuals = generation.withDefaults(mutualProps);

  const sdk = new SDK(sdkVersion);
  const serviceList = await sdk.getServiceList();

  return new Response(`// EXPERIMENTAL!
// If you like this unified mod.ts interface, get in touch so I can stabilize it faster!

import { ApiFactory } from ${JSON.stringify((fullMutuals.get('aws_api_root') ?? '.')+'/client/mod.ts')};

${Array.from(services).map(([svcId, svcOpts]) => {
  const module = serviceList[svcId];
  if (!module) throw new ClientError(404, `Service Not Found: ${svcId}`);

  const fullOpts = new URLSearchParams([...mutualProps, ...svcOpts]);
  const svcSearch = fullOpts.toString() ? `?${fullOpts}` : '';

  return `import { ${module.name} } from ${JSON.stringify(`./${svcId}.ts${svcSearch}`)};`;
}).join('\n')}

export default class AwsApi extends ApiFactory {
${Array.from(services).map(([svcId, svcOpts]) => {
  const module = serviceList[svcId];
  if (!module) throw new ClientError(404, `Service Not Found: ${svcId}`);

  return `
  #${svcId}: ${module.name} | null = null;
  public get ${svcId}() {
    if (!this.#${svcId}) this.#${svcId} = new ${module.name}(this);
    return this.#${svcId};
  }`;
}).join('\n')}
}
`, {
    status: 200,
    headers: {
      "content-type": props.wantsHtml ? "text/plain; charset=utf-8" : "application/x-typescript",
    }});
}
