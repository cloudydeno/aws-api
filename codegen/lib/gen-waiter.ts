import type * as Schema from "./sdk-schema.ts";
import type { ShapeLibrary } from "./shape-library.ts";
import { compileJMESPath } from "./jmespath.ts";
import { fixupJmesCode, cleanFuncName } from "./quirks.ts";

export default class GenWaiter {
  constructor(
    public name: string,
    public spec: Schema.WaiterSpec,
    public operation: Schema.ApiOperation,
    public shapes: ShapeLibrary,
    public includeOpts: boolean,
  ) {}

  compilePathWaiter(spec: Schema.WaiterPathMatcher): [string, string] {
    return [
      fixupJmesCode(compileJMESPath(spec.argument, 'resp')),
      spec.expected === true ? '' : ` === ${JSON.stringify(spec.expected)}`
    ];
  }

  generateTypescript(namePrefix: string): string {
    const inputShape = this.operation.input ? this.shapes.get(this.operation.input) : null;
    const outputShape = this.operation.output ? this.shapes.get(this.operation.output) : null;
    if (inputShape && inputShape?.spec.type !== 'structure') throw new Error(`TODO: ${inputShape.spec.type} input`);
    if (outputShape && outputShape?.spec.type !== 'structure') throw new Error(`TODO: ${outputShape.spec.type} input`);

    // Build a doc comment
    const docLines = new Array<string>();
    if (this.spec.description) {
      docLines.push(this.spec.description);
    }
    const totalMinutes = Math.ceil((this.spec.maxAttempts * this.spec.delay) / 60);
    docLines.push(`Checks state up to ${this.spec.maxAttempts} times, ${this.spec.delay} seconds apart (about ${totalMinutes} minutes max wait time).`);

    // Preprocess what the matchers are up to
    const goodErrs = new Array<string>();
    const badErrs = new Array<string>();
    const retryErrs = new Array<string>();
    const allPaths = new Array<string>();
    for (const acceptor of this.spec.acceptors) {
      switch (acceptor.matcher) {

        case 'error':
          switch (acceptor.state) {
            case 'success': goodErrs.push(acceptor.expected); break;
            case 'failure': badErrs.push(acceptor.expected); break;
            case 'retry': retryErrs.push(acceptor.expected); break;
          }
          break;

        case 'status':
          if (acceptor.expected >= 400) {
            const errorCode = `Http${acceptor.expected}`;
            switch (acceptor.state) {
              case 'success': goodErrs.push(errorCode); break;
              case 'failure': badErrs.push(errorCode); break;
              case 'retry': retryErrs.push(errorCode); break;
            }
          }
          break;

        case 'path':
        case 'pathAny':
        case 'pathAll':
          allPaths.push(acceptor.argument);
          break;

      }
    }
    const handlesAnyErr = this.spec.acceptors.some(x =>
      (x.matcher === 'error' && x.state !== 'failure')
      || (x.matcher === 'status' && x.expected >= 400));
    const collapsePathEval = allPaths.length > 1 && allPaths.every(x => x === allPaths[0]);

    const inputSignature = [
      // `RequestConfig`,
      inputShape?.censoredName ? `${namePrefix}${inputShape?.censoredName}` : false,
    ].filter(x => x).join(' & ');
    const outputSignature = [
      goodErrs.length > 0 ? 'Error' : '',
      // TODO: probably add heuristics on when to include this
      outputShape?.censoredName ? `${namePrefix}${outputShape?.censoredName}` : 'void',
    ].filter(x => x).join(' | ');

    const funcParams = ['params'];
    if (this.includeOpts) {
      funcParams.push('opts')
    }

    const innerChunks: string[] = [];
    const lowerCamelName = this.operation.name[0].toLowerCase() + this.operation.name.slice(1);
    innerChunks.push(`      ${outputShape ? 'const resp = ' : ''}await this.${cleanFuncName(lowerCamelName)}(${funcParams.join(', ')});`);

    if (collapsePathEval) {
      const code = fixupJmesCode(compileJMESPath(allPaths[0], 'resp'));
      innerChunks.push(`      const field = ${code};`);
    }

    for (const acceptor of this.spec.acceptors) {
      const commented = acceptor.knownBroken ? '// BROKEN: ' : '';

      const statements: {[key: string]: string} = {
        'retry': 'continue;',
        'failure': 'throw new Error(errMessage);',
        'success': outputShape ? 'return resp;' : 'return;',
      };
      const statement = statements[acceptor.state];

      switch (acceptor.matcher) {
        case 'error': continue; // handled in catch block

        case 'path': {
          const [evaluator, comparision] = this.compilePathWaiter(acceptor);
          const evalSource = collapsePathEval ? 'field' : evaluator;
          const condition = `${evalSource}${comparision}`;
          innerChunks.push(`      ${commented}if (${condition}) ${statement}`);
          break;
        }
        case 'pathAny': {
          const [evaluator, comparision] = this.compilePathWaiter(acceptor);
          const evalSource = collapsePathEval ? 'field' : evaluator;
          const condition = `${evalSource}?.some(x => x${comparision})`;
          innerChunks.push(`      ${commented}if (${condition}) ${statement}`);
          break;
        }
        case 'pathAll': {
          const [evaluator, comparision] = this.compilePathWaiter(acceptor);
          const evalSource = collapsePathEval ? 'field' : evaluator;
          const condition = `${evalSource}?.every(x => x${comparision})`;
          innerChunks.push(`      ${commented}if (${condition}) ${statement}`);
          break;
        }

        case 'status': {
          if (acceptor.expected < 400) {
            innerChunks.push(`      ${statement} // for status ${acceptor.expected}`);
          }
          break;
        }

      }
    }

    const chunks: string[] = [];

    // Write out the doc comment
    // TODO: this can be generalized somewhere else
    if (docLines.length > 1) {
      chunks.push(`  /**`);
      for (const docLine of docLines) {
        chunks.push(`   * ${docLine}`);
      }
      chunks.push(`   */`);
    } else {
      chunks.push(`  /** ${docLines[0]} */`);
    }

    chunks.push(`  async waitFor${this.name}(`);
    chunks.push(`    params: ${inputSignature},`);
    if (this.includeOpts) {
      chunks.push(`    opts: client.RequestOptions = {},`);
    }
    chunks.push(`  ): Promise<${outputSignature}> {`);
    chunks.push(`    const errMessage = 'ResourceNotReady: Resource is not in the state ${this.name}';`);
    chunks.push(`    for (let i = 0; i < ${this.spec.maxAttempts}; i++) {`);
    if (handlesAnyErr) {
      chunks.push(`      try {`);
      chunks.push(...innerChunks.map(x => '  '+x));
      chunks.push(`      } catch (thrown: unknown) {`);
      chunks.push(`        const err = thrown as client.AwsServiceError;`);
      if (goodErrs.length > 0) {
        chunks.push(`        if (${JSON.stringify(goodErrs)}.includes(err.shortCode)) return err;`);
      }
      if (badErrs.length > 0) {
        chunks.push(`        if (${JSON.stringify(badErrs)}.includes(err.shortCode)) throw err;`);
      }
      if (retryErrs.length > 0) {
        chunks.push(`        if (!${JSON.stringify(retryErrs)}.includes(err.shortCode)) throw err;`);
      } else {
        chunks.push(`        throw err;`);
      }
      chunks.push(`      }`);
    } else {
      chunks.push(...innerChunks);
    }
    chunks.push(`      await new Promise(r => setTimeout(r, ${this.spec.delay}000));`);
    chunks.push(`    }`);
    chunks.push(`    throw new Error(errMessage);`);
    chunks.push(`  }\n`);
    return chunks.join('\n');
  }
}
