import { WrapWithSpan } from "@cloudydeno/opentelemetry/instrumentation/async.ts";
import type * as Schema from '../sdk-schema.ts';
import type { ApiSpecPolicy, ApiSpecSet, SdkFetcher } from "./types.ts";

export abstract class BaseSdkFetcher implements SdkFetcher {

  abstract getSdkVersion(): Promise<string>;
  abstract getServiceList(): Promise<Record<string, Schema.ServiceMetadata>>;
  abstract getSpecList(): Promise<string[]>;
  abstract getRawApiSpec(apiId: string, apiVersion: string, suffix: keyof ApiSpecSet, policy: ApiSpecPolicy): Promise<unknown>;

  @WrapWithSpan()
  async getApiSpecs(
    apiId: string,
    apiVersion: string,
    suffixes: Partial<Record<keyof ApiSpecSet, ApiSpecPolicy>>,
  ): Promise<{
    normal: Schema.Api;
    paginators: Schema.Pagination;
    waiters2: Schema.Waiters;
    examples: Schema.Examples;
  }> {
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

  @WrapWithSpan()
  async getLatestApiVersion(modId: string): Promise<string> {
    const [svcList, specList] = await Promise.all([
      this.getServiceList(),
      this.getSpecList(),
    ]);

    const svcInfo = svcList[modId];
    if (!svcInfo) throw new /*Client*/Error(/*404, jsonTemplate*/
      `Service ${modId} not found`);
    const svcId = svcInfo.prefix || modId;

    const matches = specList
      .filter(x => x.slice(0, -11) === svcId)
      .map(x => x.slice(-10));
    if (matches.length === 0) throw new /*Client*/Error(/*404, jsonTemplate*/
      `No versions found for Service ${modId}`);

    return matches.sort().slice(-1)[0];
  }
}
