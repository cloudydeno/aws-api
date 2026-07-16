import type * as Schema from './sdk-schema.ts';
import { ShapeLibrary } from './shape-library.ts';
import { HelperLibrary } from "./helper-library.ts";
import { ProtocolCodegen } from "./protocol.ts";

import { genDocsComment } from "./gen-docs.ts";
import { StructEmitter } from "./gen-structs.ts";
import { cleanFuncName, ServiceApiClientExtras } from './quirks.ts';

const NULL_BODY_STATUS = [101, 204, 205, 304];

export function generateApiTypescript(
  apiSpec: Schema.Api,
  shapes: ShapeLibrary,
  helpers: HelperLibrary,
  protocol: ProtocolCodegen,
  namespace: string,
  namePrefix: string,
  docMode: 'none' | 'short' | 'full',
  includeOpts: boolean,
  includeClientExtras: boolean,
  useAuthType: boolean,
  alwaysReqLists: boolean,
  streamingResponses: boolean,
): string {

  const structEmitter = new StructEmitter(apiSpec, shapes, helpers, protocol, namePrefix, docMode, alwaysReqLists, streamingResponses);
  helpers.useHelper("client");

  const apiClientExtras = ServiceApiClientExtras.get(apiSpec.metadata.serviceId);
  let serviceClientSecondParam = (apiClientExtras && includeClientExtras)
    ? `, ${apiClientExtras}` : '';

  const chunks = new Array<string>();
  chunks.push(`  #client: client.ServiceClient;`);
  chunks.push(`  constructor(apiFactory: client.ApiFactory) {`);
  chunks.push(`    this.#client = apiFactory.buildServiceClient(${namespace}.ApiMetadata${serviceClientSecondParam});`);
  chunks.push(`  }\n`);
  chunks.push(`  static ApiMetadata: client.ApiMetadata = ${JSON.stringify(apiSpec.metadata, null, 2).replace(/\n/g, `\n  `)};\n`);

  for (const operation of Object.values(apiSpec.operations)) {
    const lowerCamelName = operation.name[0].toLowerCase() + operation.name.slice(1);

    let inputShape =  operation.input ? shapes.get(operation.input) : null;
    if (inputShape?.spec.type === 'structure' && Object.values(inputShape.spec.members).length === 0) {
      inputShape.refCount--;
      inputShape = null;
    }

    let outputShape = operation.output ? shapes.get(operation.output) : null;
    if (outputShape?.spec.type === 'structure' && Object.values(outputShape.spec.members).length === 0) {
      outputShape.refCount--;
      outputShape = null;
    }

    if (outputShape?.tags.has('eventstream')) {
      chunks.push(`  ${cleanFuncName(lowerCamelName)}() {`);
      chunks.push(`    // https://docs.aws.amazon.com/AmazonS3/latest/API/RESTSelectObjectAppendix.html`);
      chunks.push(`    throw new Error("TODO: The response streaming format for this API call is not implemented in /x/aws_api.");`);
      chunks.push(`  }`);
      continue;
    }

    let signature = `(`;
    if (inputShape?.spec.type === 'structure') {
      signature += '\n    params: ' + structEmitter.specifyShapeType(inputShape, {isJson: operation.input?.jsonvalue});
      if (operation.input?.payload) {
        inputShape.payloadField = operation.input.payload;
      }
      if (!inputShape.spec.required?.length && Object.values(inputShape.spec.members).every(x => x.location !== 'uri')) {
        signature += ' = {}';
      }
      signature += ',';
    } else if (inputShape) {
      throw new Error(`TODO: ${inputShape.spec.type} input`);
    }

    if (includeOpts) {
      signature += `\n    opts: client.RequestOptions = {},`;
    }

    if (signature.length > 1) {
      signature += `\n  `;
    }
    signature += `): `;

    signature += `Promise<`;
    if (outputShape?.spec.type === 'structure') {
      signature += structEmitter.specifyShapeType(outputShape, {isJson: operation.output?.jsonvalue});
    } else if (outputShape) {
      throw new Error(`TODO: ${outputShape.spec.type} output`);
    } else {
      signature += 'void';
    }
    signature += '>';

    if (operation.documentation && docMode !== 'none') {
      chunks.push(genDocsComment(operation.documentation, '  ', docMode));
    }

    chunks.push(`  async ${cleanFuncName(lowerCamelName)}${signature} {`);
    let protoPathParts: Map<string,string> | undefined;
    const referencedInputs = new Set(includeOpts ? ['opts'] : []);
    if (operation.input) {// && inputShape?.spec.type === 'structure') {
      const {inputParsingCode, inputVariables, pathParts} = protocol
        .generateOperationInputParsingTypescript(inputShape, operation.input);
      chunks.push(inputParsingCode);
      inputVariables.forEach(x => referencedInputs.add(x));
      protoPathParts = pathParts;
    }

    chunks.push(`    const resp = await this.#client.performRequest({`);
    if (typeof operation.authtype == 'string') {
      const authType = {
        'v4-unsigned-body': 'unsigned-payload',
        'none': 'anonymous',
      }[operation.authtype];
      if (useAuthType && authType) {
        chunks.push(`      authType: ${JSON.stringify(authType)},`);
      } else if (operation.authtype == 'none') {
        chunks.push(`      skipSigning: true,`);
      }
    }
    if (referencedInputs.size > 0) {
      chunks.push(`      ${Array.from(referencedInputs).join(', ')},`);
    }
    chunks.push(`      action: ${JSON.stringify(operation.name)},`);
    if (operation.http?.method && operation.http.method !== 'POST') {
      chunks.push(`      method: ${JSON.stringify(operation.http.method)},`);
    }
    if (operation.http?.requestUri && operation.http.requestUri !== '/') {
      // this.helpers.useHelper('encodePath');
      const formattedPath = operation.http?.requestUri?.includes('{')
        ? ('cmnP.encodePath`'+operation.http.requestUri
            .replace(/{[^}]+}/g, x => protoPathParts?.get(x)||x)
          +'`')
        : JSON.stringify(operation.http?.requestUri || '/');
      chunks.push(`      requestUri: ${formattedPath},`);
      if (formattedPath.startsWith('cmnP.')) {
        helpers.useHelper("cmnP");
      }
    }
    if (operation.http?.responseCode) {
      chunks.push(`      responseCode: ${JSON.stringify(operation.http.responseCode)},`);
    }
    if (operation.endpoint?.hostPrefix) {
      const templatedPrefix = operation.endpoint.hostPrefix.replace(/{/g, '${params.');
      chunks.push(`      hostPrefix: \`${templatedPrefix}\`,`);
    }
    chunks.push(`    });`);

    const isNullBody = NULL_BODY_STATUS.includes(operation.http?.responseCode ?? 200);

    if (outputShape?.spec.type === 'structure') {
      const {outputParsingCode, outputVariables} = protocol
        .generateOperationOutputParsingTypescript(outputShape, operation.output?.resultWrapper ?? outputShape?.spec.resultWrapper, isNullBody, streamingResponses);
      chunks.push(outputParsingCode);
    } else if (!isNullBody) {
      chunks.push(`    await resp.body?.cancel();`);
    }

    // TODO: is this a sane way of doing pagination?
    // type PaginatedResult<T> = T & {
    //   hasNextPage(this: T): boolean;
    //   nextPage(this: T, config?: RequestConfig): Promise<PaginatedResult<T>>;
    // }
    // hasNextPage() { return !!(this.NextToken); },
    // nextPage(config: RequestConfig = {}) {
    //   return self.describeInstances({ ...params, ...config,
    //     NextToken: this.NextToken,
    //   });
    // },

    chunks.push(`  }\n`);
  }

  return chunks.join('\n');
}
