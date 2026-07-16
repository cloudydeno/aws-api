#!/usr/bin/env -S deno run --allow-run=deno --allow-write --allow-read

import ServiceCodeGen from '../lib/code-gen.ts';
import { join as joinPath } from "@std/path/join";
import { sdk } from "./sdk.ts";
import { ServiceMetadata } from "@cloudydeno/aws-codegen/sdk-schema.ts";

const testDir = joinPath('lib','testgen','services');
await Deno.mkdir(testDir, { recursive: true });

const serviceList = await sdk.getServiceList() as Record<string, ServiceMetadata & {modId: string}>;
for (const [modId, svc] of Object.entries(serviceList)) {
  svc.modId = modId;
}

const services = new Map<string,typeof serviceList[string]>();
for (const [modId, svc] of Object.entries(serviceList)) {
  services.set(modId, svc);
  if (svc.prefix) {
    services.set(svc.prefix, svc);
  }
}

const opts = new URLSearchParams();

const generatedFiles = new Array<string>();

for (const uid of await sdk.getSpecList()) {
  const service = uid.slice(0, -11);
  const version = uid.slice(-10);

  const svc = services.get(service);
  if (!svc) throw new Error(`Missing service for '${service}'`);

  const codeGen = await ServiceCodeGen.loadFromSdk(sdk, service, version, opts);

  const code = codeGen.generateTypescript(svc.name);
  await Deno.writeTextFile(joinPath(testDir, `${uid}.ts`), code);

  generatedFiles.push(`./${uid}.ts`);
}

await Deno.writeTextFile(joinPath(testDir, 'mod.ts'), generatedFiles
  .map(x => `import {} from ${JSON.stringify(x)}`)
  .join('\n'));


const cacheStart = Date.now();
const child = await new Deno.Command('deno', {
  args: ['cache', joinPath(testDir, 'mod.ts')],
  stderr: 'inherit',
}).output();
const cacheEnd = Date.now();
console.log('Cached in', Math.round((cacheEnd - cacheStart) / 1000), 'seconds');
Deno.exit(child.code);
