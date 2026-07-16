export { httpTracer } from "@cloudydeno/opentelemetry/instrumentation/http-server.ts";

import { LogicTracer } from "@cloudydeno/opentelemetry/instrumentation/async.ts";
import { Attributes, Span, trace } from "@cloudydeno/opentelemetry/pkg/api";
export { LogicTracer, trace, type Span };

import { DenoTelemetrySdk } from "@cloudydeno/opentelemetry/sdk";

new DenoTelemetrySdk({
  resourceAttrs: {
    'service.name': 'aws-api',
  },
});

const logicWrap = new LogicTracer({
  name: 'logic-wrap',
  requireParent: false,
});
export function runAsyncSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return logicWrap.asyncSpan(name, { attributes }, span => fn(span!));
}
