
import { cachedFetch, SdkGithubFetcher } from "@cloudydeno/aws-codegen/sdk-fetcher/from-github.ts";

// Last release of AWS SDK v2:
export const sdk = new SdkGithubFetcher(cachedFetch, 'v2.1693.0');
