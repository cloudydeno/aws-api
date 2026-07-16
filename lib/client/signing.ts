// port of https://github.com/lucacasonato/deno_aws_sign_v4

import {
  Signer, Credentials,
  hmacSha256, hashSha256, bytesAsHex,
  ByteArray,
} from "./common.ts";

const ANY_BUT_DIGITS_T = /[^\dT]/g;
function toAmzDate(date: Date) {
  return `${date.toISOString().slice(0, 19).replace(ANY_BUT_DIGITS_T, "")}Z`;
};

const ANY_BUT_DIGITS = /[^\d]/g;
function toDateStamp(date: Date) {
  return date.toISOString().slice(0, 10).replace(ANY_BUT_DIGITS, "");
};

const encoder = new TextEncoder();
const AWS4 = encoder.encode("AWS4");

/**
 * This class can be used to create AWS Signature V4
 * for low-level AWS REST APIs. You can either provide
 * credentials for this API using the options in the
 * constructor, or let them be aquired automatically
 * through environment variables.
 *
 * Example usage:
 *
 * ```ts
 * const signer = new AWSSignerV4();
 * const body = new TextEncoder().encode("Hello World!")
 * const request = new Request("https://test-bucket.s3.amazonaws.com/test", {
 *   method: "PUT",
 *   headers: { "content-length": body.length.toString() },
 *   body,
 * });
 * const req = await signer.sign("s3", request);
 * const response = await fetch(req);
 * ```
 */
export class AWSSignerV4 implements Signer {
  private region: string;
  private credentials: Credentials;

  constructor(region: string, credentials: Credentials) {
    this.region = region;
    this.credentials = credentials;
  }

  /**
   * Use this to create the signed headers required to
   * make a call to an AWS API.
   *
   * @param service This is the AWS service, e.g. `s3` for s3, `dynamodb` for DynamoDB
   * @param request The Request instance to sign.
   * @returns {RequestHeaders} - the signed request headers
   */
  public async sign(
    service: string,
    request: Request,
  ): Promise<Request> {
    const {awsAccessKeyId, awsSecretKey, sessionToken} = this.credentials;

    const date = new Date();
    const amzdate = toAmzDate(date);
    const datestamp = toDateStamp(date);

    const headers = new Headers(request.headers);
    headers.set("x-amz-date", amzdate);
    if (sessionToken) {
      headers.set("x-amz-security-token", sessionToken);
    }
    headers.set("host", new URL(request.url).host);

    // we can passthru the request stream if there is already a content hash header
    let body: ByteArray | ReadableStream<ByteArray> | null = request.body;
    let payloadHash = headers.get('x-amz-content-sha256') ?? '';
    // but there probably isn't a content hash header, so let's handle that..
    if (!payloadHash) {
      // buffer the body:
      body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
      // hash it for the signature:
      payloadHash = bytesAsHex(await hashSha256(body ?? new Uint8Array()));
      // for the S3 API, also add the content hash header:
      if (service === 's3') {
        // Backblaze B2 requires this header to be in the canonicalHeaders
        headers.set("x-amz-content-sha256", payloadHash);
      }
    }

    const canonical = canonicalizeRequest(request.method, request.url, headers, payloadHash);
    const canonicalRequestDigest = await hashSha256(encoder.encode(canonical.request));

    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${datestamp}/${this.region}/${service}/aws4_request`;

    // TODO: the signingKey can be cached
    const signingKey = await getSignatureKey(awsSecretKey, datestamp, this.region, service);
    const signature = await hmacSha256(signingKey,
      `${algorithm}\n${amzdate}\n${credentialScope}\n${bytesAsHex(canonicalRequestDigest)}`);

    headers.set("Authorization", [
      `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}`,
      `SignedHeaders=${canonical.signedHeaders}`,
      `Signature=${bytesAsHex(signature)}`,
    ].join(', '));

    return new Request(
      request.url,
      {
        headers,
        method: request.method,
        body,
        redirect: request.redirect,
        signal: request.signal,
      },
    );
  }

  /**
   * Generate a "pre-signed" URL.
   * Generally used to create short-lived links to private S3 objects.
   *
   *     const url = await signer.presign('s3', {
   *       method: 'GET',
   *       url: 'https://my-bucket.s3.amazonaws.com/my-key',
   *     });
   */
  public async presign(
    service: string,
    props: {
      method?: 'GET' | 'PUT',
      url: string,
      expiresIn?: number,
      signTime?: Date,
    },
  ): Promise<string> {
    const url = new URL(props.url);
    const date = props.signTime ?? new Date();
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${toDateStamp(date)}/${this.region}/${service}/aws4_request`;

    url.searchParams.set('X-Amz-Algorithm', algorithm);
    url.searchParams.set('X-Amz-Credential', `${this.credentials.awsAccessKeyId}/${credentialScope}`);
    url.searchParams.set('X-Amz-Date', toAmzDate(date));
    url.searchParams.set('X-Amz-Expires', `${props.expiresIn ?? 86400}`);
    url.searchParams.set('X-Amz-SignedHeaders', 'host');
    if (this.credentials.sessionToken) {
      url.searchParams.set('X-Amz-Security-Token', this.credentials.sessionToken);
    }

    const headers = new Headers([['host', url.host]]);
    const canonical = canonicalizeRequest(props.method ?? 'GET', url.toString(), headers, 'UNSIGNED-PAYLOAD');
    const canonicalRequestDigest = await hashSha256(encoder.encode(canonical.request));
    if (canonical.signedHeaders !== 'host') throw new Error(
      `BUG: pre-signed headers were not just host: "${canonical.signedHeaders}"`);

    // TODO: the signingKey can be cached
    const signingKey = await getSignatureKey(this.credentials.awsSecretKey, toDateStamp(date), this.region, service);
    const signature = await hmacSha256(signingKey,
      `${algorithm}\n${toAmzDate(date)}\n${credentialScope}\n${bytesAsHex(canonicalRequestDigest)}`);

    url.searchParams.set('X-Amz-Signature', bytesAsHex(signature));
    return url.toString();
  }
}

export async function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ByteArray> {
  const keyBytes = encoder.encode(key);
  const paddedKey = new Uint8Array(4 + keyBytes.byteLength);
  paddedKey.set(AWS4, 0);
  paddedKey.set(keyBytes, 4);

  let mac = await hmacSha256(paddedKey, dateStamp);
  mac = await hmacSha256(mac, region);
  mac = await hmacSha256(mac, service);
  mac = await hmacSha256(mac, "aws4_request");
  return mac;
};

export function canonicalizeRequest(method: string, url: string, headers: Headers, payloadHash: string): {
  signedHeaders: string;
  request: string;
} {
  const { pathname, searchParams } = new URL(url);
  searchParams.sort();
  const canonicalQuerystring = searchParams.toString();

  let canonicalHeaders = "";
  let signedHeaders = "";
  for (const key of [...headers.keys()].sort()) {
    if (unsignableHeaders.has(key.toLowerCase())) continue;
    canonicalHeaders += `${key.toLowerCase()}:${headers.get(key)}\n`;
    signedHeaders += `${key.toLowerCase()};`;
  }
  signedHeaders = signedHeaders.substring(0, signedHeaders.length - 1);

  return {
    signedHeaders,
    request: [
      method, pathname, canonicalQuerystring,
      canonicalHeaders, signedHeaders,
      payloadHash,
    ].join('\n'),
  };
}

const unsignableHeaders = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
  'x-amzn-trace-id',
  'range',
  'connection',
]);
