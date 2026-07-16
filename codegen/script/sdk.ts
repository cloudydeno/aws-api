
import { SdkGithubFetcher, uncachedFetch } from "@cloudydeno/aws-codegen/sdk-fetcher/from-github.ts";

// Last release of AWS SDK v2:
export const sdk = new SdkGithubFetcher(uncachedFetch, 'v2.1693.0');
