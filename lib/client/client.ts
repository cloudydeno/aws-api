import { AWSSignerV4 } from "./signing.ts";
import {
  ServiceClient, ApiRequestConfig,
  ServiceApiClass,
  ApiMetadata,
  ApiFactory,
  AwsServiceError, ServiceError,
  Credentials, CredentialsProvider,
  getRequestId,
} from './common.ts';

import { readXmlResult, stringify } from "../encoding/xml.ts";

type FetchOpts = {
  urlPath: string,
  hostPrefix?: string,
  skipSigning?: true,
  region?: string,
};
type SigningFetcher = (request: Request, opts: FetchOpts) => Promise<Response>;

export class BaseApiFactory implements ApiFactory {
  #credentials: CredentialsProvider;
  #region?: string;
  #fixedEndpoint?: string;
  #baseDomain?: string;
  constructor(opts: {
    credentialProvider?: CredentialsProvider,
    credentials?: Credentials,
    region?: string;
    fixedEndpoint?: string;
    baseDomain?: string;
  }) {
    if (opts.credentials != null) {
      const {credentials} = opts;
      this.#credentials = { getCredentials: () => Promise.resolve(credentials) };
    } else if (opts.credentialProvider != null) {
      this.#credentials = opts.credentialProvider;
    } else throw new Error(
      `No credentials or credential source provided -- you must provide one to use this class directly`);

    try {
      this.#region = opts.region ?? Deno.env.get("AWS_REGION");
    } catch (err) {
      if (err.name !== 'PermissionDenied') throw err;
    }

    if (typeof opts.fixedEndpoint == 'string') {
      if (!opts.fixedEndpoint.includes('://')) throw new Error(
        `If provided, fixedEndpoint must be a full URL including https:// or http://`);
      this.#fixedEndpoint = opts.fixedEndpoint;
    } else if (typeof opts.baseDomain == 'string') {
      this.#baseDomain = opts.baseDomain;
    }
  }

  makeNew<T>(apiConstructor: ServiceApiClass<T>): T {
    return new apiConstructor(this);
  }

  // TODO: second argument for extra config (endpoint, logging, etc)
  buildServiceClient(apiMetadata: ApiMetadata): ServiceClient {
    if (apiMetadata.signatureVersion === 'v2') {
      throw new Error(`TODO: signature version ${apiMetadata.signatureVersion}`);
    }

    const globalEndpointPrefix = apiMetadata
      .globalEndpoint?.replace(/\.amazonaws\.com$/, '');

    // Try dual-stacking sometimes
    const endpointPrefix =
      apiMetadata.serviceId === 'S3' ? 's3.dualstack' :
      apiMetadata.endpointPrefix;

    const signingFetcher: SigningFetcher = async (request: Request, opts: FetchOpts): Promise<Response> => {
      // QUIRK: try using host routing for S3 buckets when helpful
      // TODO: this isn't actually signing relevant!
      // we just have better info here...
      if (apiMetadata.serviceId === 'S3' && opts.urlPath && !opts.hostPrefix && !this.#fixedEndpoint) {
        const [bucketName] = opts.urlPath.slice(1).split(/[?/]/);
        if (bucketName.length > 0 && !bucketName.includes('.')) {
          opts.hostPrefix = `${bucketName}.`;
          const path = opts.urlPath.slice(bucketName.length+1);
          opts.urlPath = path.startsWith('/') ? path : `/${path}`;
        }
      }

      if (opts.skipSigning) {
        // Try to find the region without trying too hard (defaulting is ok in case of global endpoints)
        const region = opts.region ?? this.#region
          ?? (await this.#credentials.getCredentials().then(x => x.region, () => undefined));
        const baseDomain = this.#baseDomain ?? getRootDomain(apiMetadata.serviceId, region);

        const endpoint = this.#fixedEndpoint ??
          `https://${opts.hostPrefix ?? ''}${baseDomain === 'aws' ? 'api.' : ''}${
            globalEndpointPrefix || `${endpointPrefix}.${region ?? throwMissingRegion()}`
          }.${baseDomain}`;

        // work around deno 1.9 request cloning regression :(
        return fetch(new URL(opts.urlPath, endpoint).toString(), {
          headers: request.headers,
          method: request.method,
          body: request.body,
          redirect: request.redirect,
          // TODO: request cancellation
          // signal: request.signal,
        });
      }

      // Resolve credentials and AWS region
      const credentials = await this.#credentials.getCredentials();
      const region = opts.region
        ?? (apiMetadata.globalEndpoint ? 'us-east-1'
        : (this.#region ?? credentials.region ?? throwMissingRegion()));

      const baseDomain = this.#baseDomain ?? getRootDomain(apiMetadata.serviceId, region);

      // TODO: service URL can vary for lots of reasons:
      // - dualstack/IPv6 on alt hostnames for EC2 (some regions) and S3 (all regions?)
      // - govcloud, aws-cn, etc
      //   ^ this should be auto detected from region now
      // - localstack, minio etc - completely custom
      //   ^ this should be supported now via `fixedEndpoint`

      const signer = new AWSSignerV4(region, credentials);
      const signingName = apiMetadata.signingName ?? apiMetadata.endpointPrefix;

      // Assemble full URL
      const endpoint = this.#fixedEndpoint ||
        `https://${opts.hostPrefix ?? ''}${baseDomain === 'aws' ? 'api.' : ''}${
          globalEndpointPrefix || `${endpointPrefix}.${region}`
        }.${baseDomain}`;
      const fullUrl = new URL(opts.urlPath, endpoint).toString();

      const req = await signer.sign(signingName, fullUrl, request);
      // console.log(req.method, url);
      return fetch(req);
    }

    return wrapServiceClient(apiMetadata, signingFetcher);
  }

  async ensureCredentialsAvailable() {
    const creds = await this.#credentials.getCredentials();
    if (creds.awsAccessKeyId) return;
    throw new Error(`Empty credentials were returned successfully (somehow?)`);
  }

  async determineCurrentRegion() {
    if (this.#region != null) return this.#region;
    const credentials = await this.#credentials.getCredentials();
    return credentials.region ?? throwMissingRegion();
  }
}

function throwMissingRegion(): never {
  throw new Error(`No region provided, try setting AWS_REGION or passing a region when constructing your client`);
}

export function wrapServiceClient(
  apiMetadata: ApiMetadata,
  signingFetcher: SigningFetcher,
): ServiceClient {
  switch (apiMetadata.protocol) {
    case 'query':
    case 'ec2':
      return new QueryServiceClient(apiMetadata.apiVersion, signingFetcher);
    case 'json':
    case 'rest-json':
      return new JsonServiceClient(apiMetadata.targetPrefix ?? 'TODO', apiMetadata.jsonVersion ?? '1.0', signingFetcher);
    case 'rest-xml':
      return new XmlServiceClient(signingFetcher);
    default: throw new Error(`TODO: protocol ${apiMetadata.protocol}`);
  }
}


export class BaseServiceClient implements ServiceClient {
  #signedFetcher: SigningFetcher;
  constructor(signedFetcher: SigningFetcher) {
    this.#signedFetcher = signedFetcher;
  }

  async performRequest(config: ApiRequestConfig & {
    body?: Uint8Array;
    headers: Headers;
  }): Promise<Response> {
    const headers = config.headers;
    const serviceUrl = config.requestUri ?? '/';
    const method = config.method ?? 'POST';

    if (config.body) {
      headers.append('content-length', config.body.length.toString());
    }

    let query = "";
    const queryS = config.query?.toString();
    if (queryS) {
      query = (serviceUrl.includes('?') ? '&' : '?') + queryS;
    }

    const request = new Request('https://example.com/', {
      method: method,
      headers: headers,
      body: config.body,
      redirect: 'manual',
      signal: config.abortSignal,
    });
    const response = await this.#signedFetcher(request, {
      urlPath: serviceUrl + query,
      region: config.region,
      skipSigning: config.skipSigning,
      hostPrefix: config.hostPrefix,
      // TODO: request handling once Deno can do it
      // signal: config.abortSignal,
    });

    if (response.status == (config.responseCode ?? 200)) {
      return response;
    } else if (response.status >= 400) {
      await handleErrorResponse(response, request.method);
    } else if (response.status >= 200 && response.status < 300) {
      console.log(`WARN: ${config.action} response was unexpected success ${response.status}`);
      return response;
    }
    throw new Error(`BUG: Unexpected HTTP response status ${response.status}`);
  }
}


export class XmlServiceClient extends BaseServiceClient {
  constructor(signedFetcher: SigningFetcher) {
    super(signedFetcher);
  }

  async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('accept', 'text/xml');

    let reqBody: Uint8Array | undefined;
    if (config.body instanceof Uint8Array) {
      reqBody = config.body;

    } else if (typeof config.body === 'string') {
      // console.log(config.body);
      reqBody = new TextEncoder().encode(config.body);
      headers.append('content-type', 'text/xml');

    } else if (config.body) throw new Error(
      `TODO: non-string body to XmlServiceClient`);

    return super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

export class JsonServiceClient extends BaseServiceClient {
  #serviceTarget: string;
  #jsonVersion: string;
  constructor(serviceTarget: string, jsonVersion: string, signedFetcher: SigningFetcher) {
    super(signedFetcher);
    this.#serviceTarget = serviceTarget;
    this.#jsonVersion = jsonVersion;
  }

  async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('x-amz-target', `${this.#serviceTarget}.${config.action}`);
    headers.append('accept', 'application/x-amz-json-'+this.#jsonVersion);

    let reqBody: Uint8Array | undefined;
    if (config.body instanceof Uint8Array) {
      reqBody = config.body;

    } else if (config.body) {
      reqBody = new TextEncoder().encode(JSON.stringify(config.body));
      headers.append('content-type', 'application/x-amz-json-'+this.#jsonVersion);
    }

    return super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

export class QueryServiceClient extends BaseServiceClient {
  #serviceVersion: string;
  constructor(serviceVersion: string, signedFetcher: SigningFetcher) {
    super(signedFetcher);
    this.#serviceVersion = serviceVersion;
  }

  async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('accept', 'text/xml');

    const method = config.method ?? 'POST';

    let reqBody: Uint8Array | undefined;

    if (config.body instanceof URLSearchParams) {
      if (method !== 'POST') throw new Error(`query is supposed to be POSTed`);
      const params = new URLSearchParams;
      params.set('Action', config.action);
      params.set('Version', this.#serviceVersion);
      // TODO: probably zero-copy this
      for (const [k, v] of config.body) {
        params.append(k, v);
      }

      reqBody = new TextEncoder().encode(params.toString());
      headers.append('content-type', 'application/x-www-form-urlencoded; charset=utf-8');
    } else if (config.body) throw new Error(`BUG: non-query based request body passed to query client`);

    return super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

async function handleErrorResponse(response: Response, reqMethod: string): Promise<never> {
  if (reqMethod === 'HEAD') {
    // console.log(response);
    // console.log(response.status, response.statusText, getRequestId(response.headers));
    throw new AwsServiceError(response, {
      Code: `Http${response.status}`,
      Message: `HTTP error status: ${response.statusText}`,
    }, getRequestId(response.headers));
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith('text/xml')
      || contentType?.startsWith('application/xml')
      || !contentType) {
    const xml = readXmlResult(await response.text());
    switch (xml.name) {

      case 'ErrorResponse': // e.g. sts
        // <ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
        //   <Error>
        //     <Type>Sender</Type>
        //     <Code>ExpiredToken</Code>
        //     <Message>The security token included in the request is expired</Message>
        //   </Error>
        //   <RequestId>90caa9d3-e248-4a7f-8fcf-c2a5d54c12b9</RequestId>
        // </ErrorResponse>
        const errNode = xml.first('Error');
        if (errNode) {
          throw new AwsServiceError(response, errNode.strings({
            required: { Code: true, Message: true, Type: true },
          }), xml.first('RequestId', false, x => x.content));
        }
        break;

      case 'Response': // e.g. ec2
        // <?xml version="1.0" encoding="UTF-8"?>
        // <Response><Errors><Error><Code>RequestExpired</Code><Message>Request has expired.</Message></Error></Errors><RequestID>433741ec-94c9-49bc-a9c8-ba59ab8972c2</RequestID></Response>
        const errors: ServiceError[] = xml.getList('Errors', 'Error')
          .map(errNode => errNode.strings({
            required: { Code: true, Message: true },
            optional: { Type: true },
          }));
        if (errors.length > 0) {
          throw new AwsServiceError(response, errors[0], xml.first('RequestID', false, x => x.content));
        }
        break;

      case 'Error': // e.g. s3
        throw new AwsServiceError(response, xml.strings({
          required: { Code: true, Message: true },
          optional: { 'Token-0': true, HostId: true },
        }), xml.first('RequestId', false, x => x.content));
    }

    // eg <AccessDeniedException><Message>...
    if (xml.name.endsWith('Exception')) {
      throw new AwsServiceError(response, {
        Code: xml.name,
        ...xml.strings({
          required: { Message: true },
          optional: { Type: true },
        }),
      }, getRequestId(response.headers));
    }

    console.log('Error DOM:', stringify(xml) );

  } else if (contentType?.startsWith('application/json')) {
    const data = await response.json();
    if (data.Error?.Code) {
      throw new AwsServiceError(response, data.Error as ServiceError, data.RequestId);
    }
    console.log('Error from server:', response, data);

  } else if (contentType?.startsWith('application/x-amz-json-1.')) {
    const data = await response.json();
    if (data.__type && data.message) {
      throw new AwsServiceError(response, {
        Code: data.__type,
        Message: data.message,
      }, getRequestId(response.headers));
    } else if (data.__type && data.Message) {
      throw new AwsServiceError(response, {
        Code: data.__type,
        Message: data.Message,
      }, getRequestId(response.headers));
    }
    console.log('Error from server:', response, data);

  } else {
    console.log('Error body:', await response.text());
  }
  throw new Error(`Unrecognizable error response of type ${contentType}`);
}

// https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Using_Endpoints.html
const dualStackEc2Regions = new Set([
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'ap-south-1',
  'sa-east-1',
]);

function getRootDomain(serviceId: string, region = 'us-east-1') {
  // partially dual-stacked APIs on new TLD
  if (serviceId === 'EC2' && dualStackEc2Regions.has(region)) return 'aws';
  // non-default partitions
  if (region.startsWith('cn-')) return 'amazonaws.com.cn';
  if (region.startsWith('us-iso-')) return 'c2s.ic.gov';
  if (region.startsWith('us-isob-')) return 'sc2s.sgov.gov';
  // old faithful
  return 'amazonaws.com';
}
