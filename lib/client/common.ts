/** The AWS credentials to use for signing. */
export interface Credentials {
  awsAccessKeyId: string;
  awsSecretKey: string;
  sessionToken?: string;
  expiresAt?: Date;
  region?: string;
}
export interface CredentialsProvider {
  getCredentials(): Promise<Credentials>;
}

/** Generic AWS Signer interface */
export interface Signer {
  sign: (service: string, request: Request) => Promise<Request>;
}

export interface EndpointParameters {
  apiMetadata: ApiMetadata;
  region: string;
  hostPrefix?: string;
  requestPath: string;
}
export interface ResolvedEndpoint {
  url: URL;
  partition?: string;
  signingRegion: string;
}
export interface EndpointResolver {
  resolveUrl: (parameters: EndpointParameters) => ResolvedEndpoint;
}

/** Request options that are provided by the original caller */
export interface RequestOptions {
  /** An `AbortSignal` object instance; allows you to communicate with an AWS request and abort it if desired via an `AbortController`. */
  signal?: AbortSignal;
}

/** The HTTP contract expected by all service API implementations */
export interface ApiRequestConfig {
  // fixed per operation
  action: string;
  method?: "POST" | "GET" | "HEAD" | "DELETE" | "PUT" | "PATCH";
  requestUri?: string;
  responseCode?: number;
  hostPrefix?: string;
  // dynamic per call
  region?: string;
  headers?: Headers;
  query?: URLSearchParams;
  body?: URLSearchParams | JSONObject | ByteArray | string | null;
  /** @deprecated Instead use authType: 'anonymous' */
  skipSigning?: true; // for unauthenticated APIs (STS, cognito)
  authType?: 'anonymous' | 'unsigned-payload';
  // extra stuff from the user
  opts?: RequestOptions;
}

export function getRequestId(headers: Headers): string | null {
  return headers.get('x-amzn-requestid') ?? headers.get('x-amz-request-id');
}

// Things that JSON can handle directly
export type JSONPrimitive = string | number | boolean | null | undefined;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = { [member: string]: JSONValue };
export type JSONArray = JSONValue[];

export interface ApiFactory {
  buildServiceClient(apiMetadata: ApiMetadata, extras?: ServiceClientExtras): ServiceClient;
  makeNew<T>(apiConstructor: ServiceApiClass<T>): T;
}
export interface ServiceClient {
  performRequest(request: ApiRequestConfig): Promise<Response>;
}
export interface ServiceApiClass<T> {
  new (apiFactory: ApiFactory): T;
}

/** Internal configuration to control a service's ApiClient behavior.*/
export interface ServiceClientExtras {
  /** Pre-signing hook for basic tasks like tweaking request headers. */
  mutateRequest?: (request: Request) => Request | Promise<Request>;
  // /** Called after a response is returned. */
  // mutateResponse?: (response: Response, request: Request) => Response | Promise<Response>;
  /** Called just before a request is sent. Useful for logging. */
  // beforeFetch?: (request: Request) => void | Promise<void>;
  /** Called after a response is returned. Useful for logging. */
  afterFetch?: (response: Response, request: Request) => void | Promise<void>;
  // /** Provides a Response without hitting network. Useful for mocking. */
  // injectResponse?: (request: Request) => Response | Promise<Response>;
}

// our understanding of how APIs can describe themselves
export interface ApiMetadata {
  "apiVersion": string;
  "auth"?: Array<"aws.auth#sigv4">;
  "awsQueryCompatible"?: unknown; // seems to be bool-ish with `{}` as truthy value
  "checksumFormat"?: "md5" | "sha256";
  "endpointPrefix": string;
  "jsonVersion"?: "1.0" | "1.1",
  "globalEndpoint"?: string;
  "protocol": "rest-xml" | "query" | "ec2" | "json" | "rest-json";
  "protocols"?: Array<"rest-xml" | "query" | "ec2" | "json" | "rest-json">;
  "protocolSettings"?: {
    "h2": "eventstream"; // only for kinesis
  };
  "serviceAbbreviation"?: string;
  "serviceFullName": string;
  "serviceId": string;
  "signatureVersion": "v2" | "v4" | "s3" | "s3v4";
  "signingName"?: string;
  "targetPrefix"?: string;
  "uid"?: string;
  "xmlNamespace"?: string;
};


// how universal is this structure?
export type ServiceError = {
  "Code": string;
  "Message"?: string | null;
  "Type"?: "Sender" | string;
  [key: string]: string | number | null | undefined;
}

export class AwsServiceError extends Error {
  origResponse: Response;
  code: string;
  shortCode: string;
  errorType: string;
  requestId: string;
  internal: ServiceError;

  constructor(resp: Response, code: string, error: ServiceError, requestId?: string | null) {
    requestId = requestId ?? "MISSING REQUEST ID";
    const shortCode = code.split(':')[0].split('#').slice(-1)[0];
    const typePart = error.Type ? `Type: ${error.Type}, ` : '';
    super(`${shortCode}: ${error.Message || new.target.name} [${typePart}Request ID: ${requestId}]`);

    this.origResponse = resp;
    this.code = code;
    this.shortCode = shortCode;
    this.errorType = error.Type ?? 'Unknown';
    this.requestId = requestId;
    this.internal = error;

    this.name = new.target.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  get originalMessage(): string | null | undefined {
    return this.internal.Message;
  }
}

///////////////////////////////////////////////
// SHA-256 routines powered by Subtle Crypto

/** An alias for Uint8Array<ArrayBuffer> for Typescript 5.7 */
export type ByteArray = ReturnType<Uint8Array["slice"]>;

const hmacSha256Alg = { name: 'HMAC', hash: { name: 'SHA-256' } };
const encoder = new TextEncoder();

/** Generate SHA-256 hash of a string with an HMAC byte-buffer key */
export async function hmacSha256(key: ByteArray, body: string): Promise<ByteArray> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, hmacSha256Alg, false, ['sign']);
  const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(body));
  return new Uint8Array(buffer);
}

/** Generate SHA-256 hash of a byte-buffer */
export async function hashSha256(content: ByteArray): Promise<ByteArray> {
  const buffer = await crypto.subtle.digest('SHA-256', content);
  return new Uint8Array(buffer);
}

/** Return a hex representation of a byte-buffer */
export function bytesAsHex(buffer: Uint8Array): string {
  return [...buffer].map(x => x.toString(16).padStart(2, '0')).join('');
}
