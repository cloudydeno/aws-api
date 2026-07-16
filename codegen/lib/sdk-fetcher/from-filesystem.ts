import type * as Schema from '../sdk-schema.ts';
import type { ApiSpecPolicy, ApiSpecSet, SdkFetcher } from "./types.ts";
import { BaseSdkFetcher } from "./base.ts";

const specSuffix = `.normal.json`;

export type CachableFetch = (mode: "immutable" | "mutable", label: string, url: string) => Promise<Response>;
export const uncachedFetch: CachableFetch = (_mode, _label, url) => fetch(url);

export class SdkFilesystemFetcher extends BaseSdkFetcher implements SdkFetcher {
  constructor(
    public readonly rootDir: string,
  ) {
    super();
  }

  async getSdkVersion(): Promise<string> {
    const packageJson = JSON.parse(await Deno.readTextFile('aws-sdk-js/package.json'));
    return `v${packageJson.version}`;
  }

  async getServiceList(): Promise<Record<string,Schema.ServiceMetadata>> {
    return JSON.parse(await Deno.readTextFile('./aws-sdk-js/apis/metadata.json'));
  }

  async getSpecList(): Promise<string[]> {
    const uids: Array<string> = [];
    for await (const entry of Deno.readDir(`./aws-sdk-js/apis`)) {
      if (!entry.name.endsWith(specSuffix)) continue;
      const uid = entry.name.slice(0, -specSuffix.length);
      uids.push(uid);
    }
    return uids;
  }

  async getRawApiSpec(
    apiId: string,
    apiVersion: string,
    suffix: keyof ApiSpecSet,
    policy: ApiSpecPolicy,
  ): Promise<unknown> {
    const jsonPath = `aws-sdk-js/apis/${apiId}-${apiVersion}.${suffix}.json`;

    const text = await Deno.readTextFile(jsonPath).catch(err => {
      if (err instanceof Deno.errors.NotFound) return null;
      return Promise.reject(err);
    });

    if (text == null) {
      if (policy === 'optional') {
        return null;
      }
      throw new Error(`Required file not found: ${jsonPath}`);
    }

    return JSON.parse(text);
  }
}
