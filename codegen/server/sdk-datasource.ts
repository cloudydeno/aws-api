import type * as Schema from '../lib/sdk-schema.ts';
import { cachedFetch } from "./cache.ts";
import { ClientError, jsonTemplate } from "./helpers.ts";
import { runAsyncSpan } from "./tracer.ts";

const specSuffix = `.normal.json`;

type CachableFetch = (mode: "immutable" | "mutable", label: string, url: string) => Promise<Response>;
interface SdkDatasource {
  getServiceList(): Promise<Record<string, Schema.ServiceMetadata>>;
  getSpecList(): Promise<string[]>;
  getLatestApiVersion(modId: string): Promise<string>;
  getRawApiSpec(apiId: string, apiVersion: string, suffix: keyof ApiSpecSet, policy: ApiSpecPolicy): Promise<unknown>;
  getApiSpecs(apiId: string, apiVersion: string, suffixes: Partial<Record<keyof ApiSpecSet, ApiSpecPolicy>>): Promise<{
    normal: Schema.Api;
    paginators: Schema.Pagination;
    waiters2: Schema.Waiters;
    examples: Schema.Examples;
  }>;
}

export class SDK implements SdkDatasource {
  static async getSdkVersions(): Promise<Array<{
    name: string;
    commit: { sha: string; url: string; };
  }>> {
    // this returns only the most recent page of tags
    // the full list, if we want it, is at /git/refs/tags
    const resp = await cachedFetch('mutable', 'sdk-tags', `https://api.github.com/repos/aws/aws-sdk-js/tags`);
    // TODO: accept: application/vnd.github.v3+json
    if (resp.status !== 200) throw new Error(
      `HTTP ${resp.status} on /tags`);
    return await resp.json();
  }
  static async getLatestSdkVersion() {
    return await this.getSdkVersions().then(x => x[0].name);
  }

  constructor(
    public sdkVersion: string,
  ) {}

  async getServiceList(): Promise<Record<string,Schema.ServiceMetadata>> {
    const resp = await cachedFetch('immutable', 'sdk-metadata', `https://raw.githubusercontent.com/aws/aws-sdk-js/${this.sdkVersion}/apis/metadata.json`);
    if (resp.status !== 200) throw new Error(
      `HTTP ${resp.status} on /apis/metadata.json`);
    return await resp.json();
  }

  async getSpecList() {
    // TODO: we can cache a calculated form better

    const root = await cachedFetch('immutable', 'sdk-tree', `https://api.github.com/repos/aws/aws-sdk-js/git/trees/${this.sdkVersion}`).then(x => x.json()) as GitTree;
    const apisTree = root.tree.find(x => x.path === 'apis');
    if (!apisTree) throw new Error(
      `No apis/ folder found in SDK root`);

    const apis = await cachedFetch('immutable', 'sdk-subtree', `https://api.github.com/repos/aws/aws-sdk-js/git/trees/${apisTree.sha}`).then(x => x.json()) as GitTree;
    return apis.tree.filter(x => x.path.endsWith(specSuffix)).map(x => x.path.slice(0, -specSuffix.length));
  }

  // TODO: use decorators when they work on deno deploy
  // @AsyncSpan
  async getLatestApiVersion(modId: string) {
    return await runAsyncSpan(`get latest api version`, {
      modId,
    }, () => this._getLatestApiVersion(modId));
  }
  async _getLatestApiVersion(modId: string) {
      const [svcList, specList] = await Promise.all([
      this.getServiceList(),
      this.getSpecList(),
    ]);

    const svcInfo = svcList[modId];
    if (!svcInfo) throw new ClientError(404, jsonTemplate
      `Service ${modId} not found`);
    const svcId = svcInfo.prefix || modId;

    const matches = specList
      .filter(x => x.slice(0, -11) === svcId)
      .map(x => x.slice(-10));
    if (matches.length === 0) throw new ClientError(404, jsonTemplate
      `No versions found for Service ${modId}`);

    return matches.sort().slice(-1)[0];
  }

  async getRawApiSpec(
    apiId: string,
    apiVersion: string,
    suffix: keyof ApiSpecSet,
    policy: ApiSpecPolicy,
  ) {
    const jsonPath = `apis/${apiId}-${apiVersion}.${suffix}.json`;

    const resp = await cachedFetch('immutable', `api-spec-${suffix}`,
      `https://raw.githubusercontent.com/aws/aws-sdk-js/${this.sdkVersion}/${jsonPath}`);

    if (resp.status === 404 && policy === 'optional') {
      await resp.arrayBuffer();
      return null;
    }
    if (resp.status !== 200) {
      await resp.arrayBuffer();
      throw new Error(`HTTP ${resp.status} on ${jsonPath}`);
    }

    // TODO: hack around https://github.com/denoland/deno/issues/10367
    const text = await resp.text();
    if (text.startsWith('404') && policy === 'optional') {
      return null;
    }
    return JSON.parse(text);
  }

  // TODO: use decorators when they work on deno deploy
  // @AsyncSpan
  async getApiSpecs(
    apiId: string,
    apiVersion: string,
    suffixes: Partial<Record<keyof ApiSpecSet, ApiSpecPolicy>>,
  ) {
    return await runAsyncSpan(`get specs`, {
      apiId, apiVersion,
    }, () => this._getApiSpecsInner(apiId, apiVersion, suffixes));
  }
  async _getApiSpecsInner(
    apiId: string,
    apiVersion: string,
    suffixes: Partial<Record<keyof ApiSpecSet, ApiSpecPolicy>>,
  ) {
    const loads = {
      normal: (suffixes['normal']
        ? this.getRawApiSpec(apiId, apiVersion, 'normal', suffixes['normal'])
        : Promise.resolve(null))
        .then(x => x ?? {}) as Promise<Schema.Api>,
      paginators: (suffixes['paginators']
        ? this.getRawApiSpec(apiId, apiVersion, 'paginators', suffixes['paginators'])
        : Promise.resolve(null))
        .then(x => x ?? { pagination: {} }) as Promise<Schema.Pagination>,
      waiters2: (suffixes['waiters2']
        ? this.getRawApiSpec(apiId, apiVersion, 'waiters2', suffixes['waiters2'])
        : Promise.resolve(null))
        .then(x => x ?? { waiters: {} }) as Promise<Schema.Waiters>,
      examples: (suffixes['examples']
        ? this.getRawApiSpec(apiId, apiVersion, 'examples', suffixes['examples'])
        : Promise.resolve(null))
        .then(x => x ?? { examples: {} }) as Promise<Schema.Examples>,
    };

    return {
      'normal': await loads.normal,
      'paginators': await loads.paginators,
      'waiters2': await loads.waiters2,
      'examples': await loads.examples,
    };
  }
  // async getApiSpecs(
  //   apiId: string,
  //   apiVersion: string,
  //   suffixes: Record<ApiSpecId, ApiSpecPolicy>,
  // ) {
  //   const loaded = await Promise.all<ApiSpecPair>([
  //     (suffixes['normal'] !== 'skip' ? this.getRawApiSpec(apiId, apiVersion, 'normal', suffixes['normal']) : Promise.resolve({}))
  //       .then(spec => ['normal', spec]),
  //     (suffixes['paginators'] !== 'skip' ? this.getRawApiSpec(apiId, apiVersion, 'paginators', suffixes['paginators']) : Promise.resolve({}))
  //       .then(spec => ['paginators', spec]),
  //     (suffixes['waiters2'] !== 'skip' ? this.getRawApiSpec(apiId, apiVersion, 'waiters2', suffixes['waiters2']) : Promise.resolve({}))
  //       .then(spec => ['waiters2', spec]),
  //     (suffixes['examples'] !== 'skip' ? this.getRawApiSpec(apiId, apiVersion, 'examples', suffixes['examples']) : Promise.resolve({}))
  //       .then(spec => ['examples', spec]),
  //   ]);

  //   return {
  //     'normal': loaded.find(x => x[0] === 'normal')![1] as Schema.Api,
  //     'paginators': loaded.find(x => x[0] === 'paginators')![1] as Schema.Pagination,
  //     'waiters2': loaded.find(x => x[0] === 'waiters2')![1] as Schema.Waiters,
  //     'examples': loaded.find(x => x[0] === 'examples')![1] as unknown,
  //   };
  // }
}

// export type ApiSpecId = 'normal' | 'paginators' | 'waiters2' | 'examples';
export type ApiSpecPolicy = 'required' | 'optional';
// type ApiSpecPair =
// | ['normal', Schema.Api]
// | ['paginators', Schema.Pagination]
// | ['waiters2', Schema.Waiters]
// | ['examples', unknown]
// ;

interface ApiSpecSet {
  'normal': Schema.Api;
  'paginators': Schema.Pagination;
  'waiters2': Schema.Waiters;
  'examples': Schema.Examples;
}
// type ApiSpecId = keyof ApiSpecSet;

interface GitTree {
  sha: string;
  url: string;
  tree: Array<{
    path: string;
    mode: string;
    type: "tree" | "blob";
    sha: string;
    size?: number;
    url: string;
  }>;
};
