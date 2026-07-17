import { join as joinPath } from "@std/path/join";
import { parse as parseYaml } from '@std/yaml';
import { SdkGithubFetcher, cachedFetch } from "../sdk-fetcher/from-github.ts";
import ServiceCodeGen from "../code-gen.ts";

if (Deno.args.length != 0) {
  throw 'Arguments not required';
}

const configText = await Deno.readTextFile('aws-api.yaml');
const configData = parseYaml(configText) as {
  outDir?: string;
  emitServiceDirs?: boolean;
  opts?: Record<string,string>;
  sdkVersion?: string;
  services?: Record<string, {
    version?: string;
    actions?: Array<string>;
    opts?: Record<string,string>;
  } | null>;
};

const outDir = configData.outDir ?? 'aws-api';
await Deno.mkdir(outDir, { recursive: true });

const sdkVersion = configData.sdkVersion ?? 'v2.1693.0';
console.log(`Using AWS-SDK-JS ${sdkVersion}`);
const sdk = new SdkGithubFetcher(cachedFetch, sdkVersion);

const serviceList = await sdk.getServiceList();

for (const [serviceId, serviceProps] of Object.entries(configData.services ?? {})) {

  const module = serviceList[serviceId];
  if (!module) throw new Error(`API ${serviceId} not found. Check the API listing for exact spelling.`);

  const apiVersion = serviceProps?.version || await sdk.getLatestApiVersion(serviceId);

  const opts = new URLSearchParams(configData.opts ?? {});
  if (serviceProps?.actions) {
    opts.set('actions', serviceProps.actions.join(','));
  }
  for (const override of Object.entries(serviceProps?.opts ?? {})) {
    opts.set(override[0], override[1]);
  }

  const apiId = module.prefix || serviceId;
  const codeGen = await ServiceCodeGen.loadFromSdk(sdk, apiId, apiVersion, opts);

  if (configData.emitServiceDirs) {
    const modCode = codeGen.generateModTypescript(module.name);
    const structsCode = codeGen.generateStructsTypescript();

    const dirPath = joinPath(outDir, serviceId);
    await Deno.mkdir(dirPath, { recursive: true });

    const modPath = joinPath(dirPath, 'mod.ts');
    await Deno.writeTextFile(modPath, modCode);
    console.log('Wrote', modPath, `(${Math.ceil(modCode.length / 1024)} KiB)`);

    const structsPath = joinPath(dirPath, 'structs.ts');
    await Deno.writeTextFile(structsPath, structsCode);
    console.log('Wrote', structsPath, `(${Math.ceil(structsCode.length / 1024)} KiB)`);

  } else {
    const modCode = codeGen.generateTypescript(module.name);

    const outFile = joinPath(outDir, `${serviceId}.ts`);
    await Deno.writeTextFile(outFile, modCode);
    console.log('Wrote', outFile, `(${Math.ceil(modCode.length / 1024)} KiB)`);
  }
}
