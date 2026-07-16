import { AWSSignerV4 } from "./signing.ts";
import {
  ServiceClient, ApiRequestConfig,
  ServiceApiClass,
  ApiMetadata,
  ApiFactory,
  AwsServiceError, ServiceError,
  Credentials, CredentialsProvider,
  getRequestId,
  EndpointResolver,
  ServiceClientExtras,
  ByteArray,
} from './common.ts';

import { readXmlResult, stringify, XmlNode } from "../encoding/xml.ts";

type FetchOpts = {
  urlPath: string,
  hostPrefix?: string,
  skipSigning?: true,
  region?: string,
};
type SigningFetcher = (request: Request, opts: FetchOpts) => Promise<Response>;

export class BaseApiFactory implements ApiFactory {
  #credentials: CredentialsProvider;
  #endpointResolver: EndpointResolver;
  #region?: string | null;
  #extras: ServiceClientExtras;
  constructor(opts: {
    credentialProvider?: CredentialsProvider;
    credentials?: Credentials;
    endpointResolver: EndpointResolver;
    region?: string;
    fixedEndpoint?: string;
    extras?: ServiceClientExtras;
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
    } catch (err: unknown) {
      if ((err as Error).name !== 'PermissionDenied') throw err;
    }

    this.#endpointResolver = opts.endpointResolver;
    this.#extras = opts.extras ?? {};
  }

  makeNew<T>(apiConstructor: ServiceApiClass<T>): T {
    return new apiConstructor(this);
  }

  buildServiceClient(apiMetadata: ApiMetadata, extras?: ServiceClientExtras): ServiceClient {
    // TODO: seems like importexport and sdb still reference v2
    if (apiMetadata.signatureVersion === 'v2') throw new Error(
      `TODO: signature version ${apiMetadata.signatureVersion}`);

    const signingFetcher: SigningFetcher = async (baseRequest: Request, opts: FetchOpts): Promise<Response> => {

      // Only happens at most once, because undefined !== null
      if (this.#region === undefined && !opts.region) {
        this.#region = await this.#credentials.getCredentials().then(x => x.region, () => null);
      }

      const { url, signingRegion } = this.#endpointResolver
        .resolveUrl({
          apiMetadata: apiMetadata,
          region: opts.region ?? this.#region ?? throwMissingRegion(),
          requestPath: opts.urlPath,
          hostPrefix: opts.hostPrefix,
        });

      let request = new Request(url.toString(), baseRequest);

      if (extras?.mutateRequest) {
        request = await extras.mutateRequest(request);
      }
      if (this.#extras.mutateRequest) {
        request = await this.#extras.mutateRequest(request);
      }

      if (!opts.skipSigning) {
        const credentials = await this.#credentials.getCredentials();
        const signer = new AWSSignerV4(signingRegion, credentials);
        const signingName = apiMetadata.signingName
          ?? apiMetadata.endpointPrefix;

        request = await signer.sign(signingName, request);
      }

      const response = await fetch(request);

      if (extras?.afterFetch) {
        await extras.afterFetch(response, request);
      }
      if (this.#extras.afterFetch) {
        await this.#extras.afterFetch(response, request);
      }

      return response;
    }

    return wrapServiceClient(apiMetadata, signingFetcher);
  }

  async ensureCredentialsAvailable(): Promise<void> {
    const creds = await this.#credentials.getCredentials();
    if (creds.awsAccessKeyId) return;
    throw new Error(`Empty credentials were returned successfully (somehow?)`);
  }

  async determineCurrentRegion(): Promise<string> {
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
      return new JsonServiceClient(apiMetadata.targetPrefix ?? 'TODO', apiMetadata.jsonVersion ?? '1.0', signingFetcher);
    case 'rest-json':
      return new RestJsonServiceClient(signingFetcher);
    case 'rest-xml':
      return new XmlServiceClient(signingFetcher);
    default: throw new Error(`TODO: protocol ${apiMetadata.protocol}`);
  }
}


export class BaseServiceClient implements ServiceClient {
  constructor(
    private readonly signedFetcher: SigningFetcher,
    public readonly protocol: string,
  ) {}

  async performRequest(config: ApiRequestConfig & {
    body?: ByteArray;
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
      signal: config.opts?.signal,
    });
    const response = await this.signedFetcher(request, {
      urlPath: serviceUrl + query,
      region: config.region,
      skipSigning: config.authType == 'anonymous' || config.skipSigning,
      hostPrefix: config.hostPrefix,
    });

    if (response.status == (config.responseCode ?? 200)) {
      return response;
    } else if (response.status >= 400) {
      await handleErrorResponse(response, request.method, this.protocol);
    } else if (response.status >= 200 && response.status < 300) {
      console.log(`WARN: ${config.action} response was unexpected success ${response.status}`);
      return response;
    }
    throw new Error(`BUG: Unexpected HTTP response status ${response.status}`);
  }
}


export class XmlServiceClient extends BaseServiceClient {
  constructor(signedFetcher: SigningFetcher) {
    super(signedFetcher, 'xml');
  }

  override async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('accept', 'text/xml');

    let reqBody: ByteArray | undefined;
    if (config.body instanceof Uint8Array) {
      reqBody = config.body;

    } else if (typeof config.body === 'string') {
      // console.log(config.body);
      reqBody = new TextEncoder().encode(config.body);
      headers.append('content-type', 'text/xml');

    } else if (config.body) throw new Error(
      `TODO: non-string body to XmlServiceClient`);

    return await super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

export class JsonServiceClient extends BaseServiceClient {
  constructor(
    public readonly serviceTarget: string,
    public readonly jsonVersion: string,
    signedFetcher: SigningFetcher
  ) {
    super(signedFetcher, 'json');
  }

  override async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('x-amz-target', `${this.serviceTarget}.${config.action}`);
    headers.append('accept', 'application/x-amz-json-'+this.jsonVersion);

    let reqBody: ByteArray | undefined;
    if (config.body instanceof Uint8Array) {
      reqBody = config.body;

    } else if (config.body) {
      reqBody = new TextEncoder().encode(JSON.stringify(config.body));
      headers.append('content-type', 'application/x-amz-json-'+this.jsonVersion);
    }

    return await super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

export class RestJsonServiceClient extends BaseServiceClient {
  constructor(signedFetcher: SigningFetcher) {
    super(signedFetcher, 'rest-json');
  }

  override async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('accept', 'application/json');

    let reqBody: ByteArray | undefined;
    if (config.body instanceof Uint8Array) {
      reqBody = config.body;

    } else if (config.body) {
      reqBody = new TextEncoder().encode(JSON.stringify(config.body));
      headers.append('content-type', 'application/json');
    }

    return await super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

export class QueryServiceClient extends BaseServiceClient {
  #serviceVersion: string;
  constructor(serviceVersion: string, signedFetcher: SigningFetcher) {
    super(signedFetcher, 'query');
    this.#serviceVersion = serviceVersion;
  }

  override async performRequest(config: ApiRequestConfig): Promise<Response> {
    const headers = config.headers ?? new Headers;
    headers.append('accept', 'text/xml');

    const method = config.method ?? 'POST';

    let reqBody: ByteArray | undefined;

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

    return await super.performRequest({
      ...config,
      headers,
      body: reqBody,
    });
  }
}

/** Not for external use - exposed for internal testing only */
export async function handleErrorResponse(response: Response, reqMethod: string, protocol: string): Promise<never> {
  if (reqMethod === 'HEAD') {
    throw new AwsServiceError(response, `Http${response.status}`, {
      Code: `Http${response.status}`,
      Message: `HTTP error status: ${response.statusText}`,
    }, getRequestId(response.headers));
  }

  const contentType = response.headers.get('content-type');

  if (contentType?.includes('json') || protocol == 'rest-json' || protocol == 'json') {
    const data = await response.json();

    if (data.Error?.Code) {
      throw new AwsServiceError(response, data.Error.Code, data.Error, data.RequestId);
    }

    const Code = response.headers.get('x-amzn-errortype')
      || data.__type || data.code || data.Code
      || 'UnknownError';
    const Message = (Code === 'RequestEntityTooLarge')
      ? 'Request body must be less than 1 MB'
      : data.message || data.Message || null;

    throw new AwsServiceError(response, Code, {
      Status: response.status,
      Code, Message,
      ...data,
    }, getRequestId(response.headers));

  } else if (contentType?.startsWith('text/xml')
      || contentType?.startsWith('application/xml')
      || protocol == 'query'
      || protocol == 'rest-xml'
      || !contentType) {

    const xml = readXmlResult(await response.text());
    const requestId = xml.first('RequestId', false, x => x.content)
        || xml.first('RequestID', false, x => x.content)
        || getRequestId(response.headers);

    switch (xml.name) {

      case 'ErrorResponse': // e.g. sts
        const errNode = xml.first('Error');
        if (errNode) throw readXmlError(response, errNode, requestId);
        break;

      case 'Response': // e.g. ec2
        const errors: AwsServiceError[] = xml.getList('Errors', 'Error')
          .map(errNode => readXmlError(response, errNode, requestId));
        if (errors.length > 0) { // TODO: more than one?? zero???
          throw errors[0];
        }
        break;

      case 'Error': // e.g. s3
        throw readXmlError(response, xml, requestId);
    }

    // eg <AccessDeniedException><Message>...
    // TODO: what service returns this?
    if (xml.name.endsWith('Exception')) {
      throw readXmlError(response, xml, requestId, xml.name);
    }

    console.log('Error DOM:', stringify(xml) );
    throw new Error(`Unrecognizable XML error response of type ${contentType} / ${protocol}`);

  } else {
    console.log('Error body:', await response.text());
    throw new Error(`Not sure about error response for ${contentType} / ${protocol}`);
  }
}

function readXmlError(response: Response, errNode: XmlNode, requestId: string | null, defaultCode = 'UnknownError') {
  const data: ServiceError = {
    Status: response.status,
    Code: defaultCode,
  };

  for (const child of errNode.children) {
    if (child.content) {
      data[child.name] = child.content;
    }
  }

  return new AwsServiceError(response, data.Code, data, requestId);
}
