// import { S3 } from "./s3-api.ts";
// import { ApiFactory } from "../../lib/client/mod.ts";
import { AsyncTracer, Span } from "./tracer.ts";

// can maybe replace this whole dep with deno edge cache once it's out of beta
import type { Cache } from "./httpcache/mod.ts";
import { inMemoryCache } from "./httpcache/in_memory.ts";
// import { s3Cache } from "./cache-s3.ts";
import { platformCache } from "./cache-platform.ts";

// const s3Api = new ApiFactory({
//   region: Deno.env.get('HTTPCACHE_S3_REGION') || 'us-east-2',
// }).makeNew(S3);

const caches: Array<Cache> = [
  inMemoryCache(40),
  await platformCache(),
  // s3Cache(s3Api, Deno.env.get('HTTPCACHE_S3_BUCKET') || 'deno-httpcache'),
];
const cacheLabels = ['in-memory', 'platform', 's3'];

const tracer = new AsyncTracer('cached-fetch');

export async function cachedFetch(mode: 'immutable' | 'mutable', label: string, url: string) {
  return await tracer.runAsyncSpan(`fetch ${label}`, {
    'cache.label': label,
    'cache.mode': mode,
  }, span => cachedFetchInner(mode, label, url, span));
}
async function cachedFetchInner(mode: 'immutable' | 'mutable', label: string, url: string, span: Span) {

  for (const [cacheIdx, cache] of caches.entries()) {
    const cached = await cache.match(url).catch(err => {
      console.error(`WARN: cache lookup err:`, err.message);
      // TODO: eventually I think there will be an exception attributes parameter
      span.recordException(err);
      span.addEvent('cache.match', {
        'cache.result': 'fail',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      });
      return null;
    });
    if (cached) {
      span.addEvent('cache.match', {
        'cache.result': 'hit',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      });
      span.setAttributes({
        'cache.result': 'hit',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      });

      // Copy colder bodies into warmer caches
      if (cacheIdx > 0) {
        await Promise.all(caches
          .slice(0, cacheIdx)
          .map((cache, cacheIdx) => emitCachePut(span, cacheIdx, cache.put(url, cached))));
      }

      return cached;
    } else {
      span.addEvent('cache.match', {
        'cache.result': 'miss',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      });
    }
  }

  span.setAttributes({
    'cache.result': 'miss',
    'cache.tier': 'none',
  });

  const realResp = await fetch(url);
  console.log('fetched', realResp.status, url);

  const resp = new Response(realResp.body, realResp);

  if (mode === 'immutable') {
    if (resp.status === 200) {
      resp.headers.delete('expires');
      resp.headers.set('cache-control', 'immutable');
    } else if (resp.status === 404) {
      resp.headers.delete('expires');
      resp.headers.set('cache-control', 'max-age=3600');
    } else {
      resp.headers.set('cache-control', 'max-age=300');
    }
  } else {
    resp.headers.set('cache-control', 'max-age=300');
  }

  await Promise.all(caches
    .map((cache, cacheIdx) => emitCachePut(span, cacheIdx, cache.put(url, resp))));

  return resp;
}

async function emitCachePut(span: Span, cacheIdx: number, promise: Promise<void>) {
  return await promise
    .then(() =>
      span.addEvent('cache.put', {
        'cache.result': 'ok',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      }))
    .catch(err => {
      console.error(`WARN: cache store err:`, err.message);
      span.recordException(err);
      span.addEvent('cache.put', {
        'cache.result': 'fail',
        'cache.index': cacheIdx,
        'cache.tier': cacheLabels[cacheIdx],
      });
      return null;
    });
}
