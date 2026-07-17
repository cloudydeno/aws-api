import { LogicTracer } from "@cloudydeno/opentelemetry/instrumentation/async.ts";
import { Attributes, Span, trace } from "@cloudydeno/opentelemetry/pkg/api";
export { LogicTracer, trace, type Span };

const logicWrap = new LogicTracer({
  name: 'logic-wrap',
  requireParent: false,
});
export function runAsyncSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return logicWrap.asyncSpan(name, { attributes }, span => fn(span!));
}
