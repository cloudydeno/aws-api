import type * as Schema from '../lib/sdk-schema.ts';
import { ShapeLibrary } from '../lib/shape-library.ts';
import { type HelperLibrary, makeHelperLibrary } from "../lib/helper-library.ts";
import { makeProtocolCodegenFor } from "../lib/protocol.ts";

import { fixupApiSpec, fixupWaitersSpec } from '../lib/quirks.ts';
import GenWaiter from "../lib/gen-waiter.ts";
import { generateApiTypescript } from "../lib/gen-api.ts";
import { StructEmitter } from "../lib/gen-structs.ts";
import type { SdkFetcher } from "./sdk-fetcher/types.ts";

export default class ServiceCodeGen {
  apiSpec: Schema.Api;
  pagersSpec?: Schema.Pagination;
  waitersSpec?: Schema.Waiters;

  isTest: boolean;
  docMode: 'none' | 'short' | 'full';
  includeOpts: boolean; // for codegen v0.2
  includeJsonRemap: boolean; // for codegen v0.3
  includeClientExtras: boolean; // for aws-api v0.6.0
  useAuthType: boolean; // for aws-api v0.6.0
  alwaysReqLists: boolean; // for codegen v0.2 and earlier
  streamingResponses: boolean; // for codegen v0.3 and earlier
  useJsr: boolean; // for codegen v0.4 and earlier
  useImportMap: boolean; // for codegen v0.4 and earlier
  stdModRoot: string | null;
  awsApiRoot: string | null;
  shapes: ShapeLibrary;

  static async loadFromSdk(sdk: SdkFetcher, serviceId: string, serviceVersion: string, opts: URLSearchParams) {
    const apiSpecs = await sdk.getApiSpecs(serviceId, serviceVersion, {
      normal: 'required',
      paginators: 'optional',
      waiters2: 'optional',
    });

    const codeGen = new ServiceCodeGen({
      api: apiSpecs.normal,
      pagers: apiSpecs.paginators,
      waiters: apiSpecs.waiters2,
    }, opts);
    return codeGen;
  }

  constructor(specs: {
    api: Schema.Api,
    pagers?: Schema.Pagination,
    waiters?: Schema.Waiters,
    isTest?: true,
  }, opts: URLSearchParams) {

    this.apiSpec = specs.api;
    this.pagersSpec = specs.pagers;
    this.waitersSpec = specs.waiters;
    this.isTest = specs.isTest ?? false;

    const docMode = opts.get('docs');
    if (docMode === 'short' || docMode === 'full') {
      this.docMode = docMode;
    } else {
      this.docMode = 'none';
    }

    this.stdModRoot = opts.get('std_mod_root') || null;
    this.awsApiRoot = opts.get('aws_api_root') || null;

    this.includeOpts = (opts.get('includeOpts') || 'yes') !== 'no';
    this.includeJsonRemap = (opts.get('includeJsonRemap') || 'yes') !== 'no';
    this.includeClientExtras = (opts.get('includeClientExtras') || 'yes') !== 'no';
    this.useAuthType = (opts.get('useAuthType') || 'yes') !== 'no';
    this.alwaysReqLists = (opts.get('alwaysReqLists') || 'no') !== 'no';
    this.streamingResponses = (opts.get('streamingResponses') || 'yes') !== 'no';
    this.useJsr = (opts.get('useJsr') || 'yes') !== 'no';
    this.useImportMap = (opts.get('useImportMap') || 'yes') !== 'no';

    // mutate the specs to fix inaccuracies
    fixupApiSpec(this.apiSpec);
    if (this.waitersSpec) {
      fixupWaitersSpec(this.waitersSpec, this.apiSpec);
    }

    this.shapes = ShapeLibrary.fromApiSpec(specs.api);
  }

  private renderHelperString(helpers: HelperLibrary) {
    let helperSource = helpers.toSourceString();
    if (this.stdModRoot) {
      // TODO: intentionally excluding md5 imports, as it was removed from std later on
      helperSource = helperSource.replaceAll(/from "https:\/\/deno.land\/std@[0-9.]+\/([^"]+)/g, (orig, pkg) => pkg.includes('md5') ? orig : `from "${this.stdModRoot}/${pkg}`)
    }
    if (this.awsApiRoot) {
      helperSource = helperSource.replaceAll('@cloudydeno/aws-api', this.awsApiRoot);
    }
    if (this.useImportMap) {
      helperSource = helperSource.replaceAll(/from "jsr:(@[^\/]+\/[^@\/]+)@[^\/"]+/g, (_, x) => `from "${x}`);
    }
    return helperSource;
  }

  generateTypescript(namespace: string): string {
    const helpers = makeHelperLibrary({
      isTest: this.isTest,
      useJsr: this.useJsr,
    });
    const protocol = makeProtocolCodegenFor(this.apiSpec.metadata, this.shapes, helpers, {
      includeJsonRemap: this.includeJsonRemap,
    });

    const chunks = new Array<string>();
    chunks.push(`export class ${namespace} {`);

    const structGen = new StructEmitter(this.apiSpec, this.shapes, helpers, protocol, '', this.docMode, this.alwaysReqLists, this.streamingResponses);
    chunks.push(generateApiTypescript(this.apiSpec, this.shapes, helpers, protocol, namespace, '', this.docMode, this.includeOpts, this.includeClientExtras, this.useAuthType, this.alwaysReqLists, this.streamingResponses));

    if (this.waitersSpec && Object.keys(this.waitersSpec.waiters).length > 0) {
      chunks.push(`  // Resource State Waiters\n`);
      for (const [name, spec] of Object.entries(this.waitersSpec.waiters)) {
        const operation = this.apiSpec.operations[spec.operation];
        if (operation) {
          const waiter = new GenWaiter(name, spec, operation, this.shapes, this.includeOpts);
          chunks.push(waiter.generateTypescript(''));
        } else {
          chunks.push(`  // waitFor${name}() skipped - depends on ${spec.operation}`);
        }
      }
    }

    chunks.push(`}\n`);

    chunks.push(structGen.generateStructsTypescript(['iface', 'mapping']));

    return [
      `// Autogenerated API client for: ${this.apiSpec.metadata.serviceFullName}`,
      this.renderHelperString(helpers),
      chunks.join('\n'),
    ].filter(x => x).join('\n\n');
  }

  generateModTypescript(namespace: string): string {
    const helpers = makeHelperLibrary({
      isTest: this.isTest,
      useJsr: this.useJsr,
    });
    const protocol = makeProtocolCodegenFor(this.apiSpec.metadata, this.shapes, helpers, {
      includeJsonRemap: this.includeJsonRemap,
    });

    helpers.addDep("s", "./structs.ts");

    const chunks = new Array<string>();
    chunks.push(`export class ${namespace} {`);

    const structGen = new StructEmitter(this.apiSpec, this.shapes, helpers, protocol, 's.', this.docMode, this.alwaysReqLists, this.streamingResponses);
    chunks.push(generateApiTypescript(this.apiSpec, this.shapes, helpers, protocol, namespace, 's.', this.docMode, this.includeOpts, this.includeClientExtras, this.useAuthType, this.alwaysReqLists, this.streamingResponses));

    if (this.waitersSpec && Object.keys(this.waitersSpec.waiters).length > 0) {
      chunks.push(`  // Resource State Waiters\n`);
      for (const [name, spec] of Object.entries(this.waitersSpec.waiters)) {
        const operation = this.apiSpec.operations[spec.operation];
        const waiter = new GenWaiter(name, spec, operation, this.shapes, this.includeOpts);
        chunks.push(waiter.generateTypescript('s.'));
      }
    }

    chunks.push(`}\n`);

    chunks.push(structGen.generateStructsTypescript(['mapping']));

    return [
      `// Autogenerated API client for: ${this.apiSpec.metadata.serviceFullName}`,
      this.renderHelperString(helpers),
      chunks.join('\n'),
    ].filter(x => x).join('\n\n');
  }

  generateStructsTypescript(): string {
    const helpers = makeHelperLibrary({
      isTest: this.isTest,
      useJsr: this.useJsr,
    });
    const protocol = makeProtocolCodegenFor(this.apiSpec.metadata, this.shapes, helpers, {
      includeJsonRemap: this.includeJsonRemap,
    });

    const structGen = new StructEmitter(this.apiSpec, this.shapes, helpers, protocol, '', this.docMode, this.alwaysReqLists, this.streamingResponses);
    const structCode = structGen.generateStructsTypescript(['iface']);

    return [
      `// Autogenerated API structures for: ${this.apiSpec.metadata.serviceFullName}`,
      this.renderHelperString(helpers),
      structCode,
    ].filter(x => x).join('\n\n');
  }

}
