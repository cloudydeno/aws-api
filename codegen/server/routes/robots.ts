import { ResponseText, RouteHandler } from "../helpers.ts";

// Try to keep robots away from the generated content
// Maybe one day we'll provide better HTML for each service,
//   that HTML would be ok to index but code is not worth it
export const routeMap = new Map<string | URLPattern, RouteHandler>([

  ['/robots.txt', () => ResponseText(200, `
    User-agent: *
    Disallow: /*.ts
    Disallow: /*.ts?*
    Disallow: /*/sdk@*
  `.replace(/^ +/gm, '').trimStart())],

  ['/googlef62da8eb52763e2f.html', () => ResponseText(200,
    `google-site-verification: googlef62da8eb52763e2f.html`)],

]);
