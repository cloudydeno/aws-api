import type * as Schema from '../sdk-schema.ts';

export interface SdkFetcher {
  getSdkVersion(): Promise<string>;
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

export type ApiSpecPolicy = 'required' | 'optional';

export interface ApiSpecSet {
  'normal': Schema.Api;
  'paginators': Schema.Pagination;
  'waiters2': Schema.Waiters;
  'examples': Schema.Examples;
}
