export const Pattern = (pathname: string) => new URLPattern({ pathname });
export type RouteHandler = (context: {
  params: Record<string, string | undefined>;
  requestUrl: URL;
  headers: Headers,
}) => Response | Promise<Response>;

import { escape } from "@std/html/entities";
export { escape };
export function escapeTemplate(strings: TemplateStringsArray, ...inputs: string[]) {
  return String.raw(strings, ...inputs.map(escape));
}

export function jsonTemplate(strings: TemplateStringsArray, ...inputs: unknown[]) {
  return String.raw(strings, ...inputs.map(x => JSON.stringify(x)));
}

export function acceptsHtml(requestHeaders: Headers) {
  const acceptTokens = requestHeaders.get('accept')?.split(',').map(x => x.trim());
  return acceptTokens?.some(x => x.startsWith('text/html')) ?? false;
}

// Response.redirect() throws in Deno 1.9 unless url is absolute
// So we DIY
export function ResponseRedirect(location: string, extraHeaders?: Record<string,string>) {
  return new Response(null, {
    status: 302,
    headers: { location, ...extraHeaders },
  });
}

export function ResponseText(status: number, body: string) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export function ResponseJson(data: unknown) {
  const text = JSON.stringify(data, null, 1);
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

export function ResponseError(err: unknown) {
  if (err instanceof ClientError) {
    console.log(`Returning ${err.message}`);
    return ResponseText(err.statusCode, err.message);
  }
  const msg = (err instanceof Error) ? (err.stack || err.message) : JSON.stringify(err);
  console.error('!!!', msg);
  return ResponseText(500, `Internal Error!

Feel free to try a second attempt.
File any issues here: https://github.com/cloudydeno/deno-aws_api/issues

Internal stacktrace follows:
${msg}`);
}

export class ClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    init?: { cause?: any; },
  ) {
    super(`HTTP ${statusCode}: ${statusText}`, init);
    Error.captureStackTrace(this, new.target);
    this.name = new.target.name;
  }
}

export function getModuleIdentity(requestUrl: URL) {
  const params = requestUrl.searchParams;
  if (params.get('actions') === '') {
    params.delete('actions');
  }
  if (params.get('docs') === '') {
    params.delete('docs');
  }
  const search = `${params.toString() ? '?' : ''}${params}`;
  const selfUrl = `${requestUrl.origin}${requestUrl.pathname}${search}`;
  params.sort();

  return {params, selfUrl};
}
