import type * as Schema from '../sdk-schema.ts';
import type { ApiSpecPolicy, ApiSpecSet, SdkFetcher } from "./types.ts";
import { BaseSdkFetcher } from "./base.ts";
export { cachedFetch } from '../httpcache/cached-fetch.ts';

const specSuffix = `.normal.json`;

export type CachableFetch = (mode: "immutable" | "mutable", label: string, url: string) => Promise<Response>;
export const uncachedFetch: CachableFetch = (_mode, _label, url) => fetch(url);

export class SdkGithubFetcher extends BaseSdkFetcher implements SdkFetcher {

  static async getSdkVersions(
    cachedFetch: CachableFetch,
  ): Promise<Array<{
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

  static async getLatestSdkVersion(
    cachedFetch: CachableFetch,
  ): Promise<string> {
    return await this.getSdkVersions(cachedFetch).then(x => x[0].name);
  }

  constructor(
    private readonly cachedFetch: CachableFetch,
    public readonly sdkVersion: string,
  ) {
    super();
  }

  getSdkVersion(): Promise<string> {
    return Promise.resolve(this.sdkVersion);
  }

  async getServiceList(): Promise<Record<string,Schema.ServiceMetadata>> {
    const resp = await this.cachedFetch('immutable', 'sdk-metadata', `https://raw.githubusercontent.com/aws/aws-sdk-js/${this.sdkVersion}/apis/metadata.json`);
    if (resp.status !== 200) throw new Error(
      `HTTP ${resp.status} on /apis/metadata.json`);
    return await resp.json();
  }

  async getSpecList(): Promise<string[]> {
    // TODO: we can cache a calculated form better

    const root = await this.cachedFetch('immutable', 'sdk-tree', `https://api.github.com/repos/aws/aws-sdk-js/git/trees/${this.sdkVersion}`).then(x => x.json()) as GitTree;
    const apisTree = root.tree.find(x => x.path === 'apis');
    if (!apisTree) throw new Error(
      `No apis/ folder found in SDK root`);

    const apis = await this.cachedFetch('immutable', 'sdk-subtree', `https://api.github.com/repos/aws/aws-sdk-js/git/trees/${apisTree.sha}`).then(x => x.json()) as GitTree;
    return apis.tree.filter(x => x.path.endsWith(specSuffix)).map(x => x.path.slice(0, -specSuffix.length));
  }

  async getRawApiSpec(
    apiId: string,
    apiVersion: string,
    suffix: keyof ApiSpecSet,
    policy: ApiSpecPolicy,
  ): Promise<unknown> {
    const jsonPath = `apis/${apiId}-${apiVersion}.${suffix}.json`;

    const resp = await this.cachedFetch('immutable', `api-spec-${suffix}`,
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

  async getTextFile(path: string): Promise<string> {
    const resp = await this.cachedFetch('immutable', `text-file`,
      `https://raw.githubusercontent.com/aws/aws-sdk-js/${this.sdkVersion}/${path}`);
    if (!resp.ok) throw new Error(`Received HTTP ${resp.status} fetching ${path}`);
    return await resp.text();
  }

}

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
