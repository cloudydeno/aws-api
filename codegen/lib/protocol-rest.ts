import type * as Schema from './sdk-schema.ts';
import { ShapeLibrary, KnownShape } from "./shape-library.ts";
import type { HelperLibrary } from "./helper-library.ts";

import ProtocolJsonCodegen from "./protocol-json.ts";
import ProtocolXmlCodegen from "./protocol-xml.ts";

export default class ProtocolRestCodegen {
  shapes: ShapeLibrary;
  helpers: HelperLibrary;
  constructor(
    public innerProtocol: ProtocolJsonCodegen | ProtocolXmlCodegen,
  ) {
    this.shapes = innerProtocol.shapes;
    this.helpers = innerProtocol.helpers;
  }

  generateOperationInputParsingTypescript(inputShape: KnownShape | null, meta: Schema.LocationInfo) {
    if (!inputShape) {
      return this.innerProtocol.generateOperationInputParsingTypescript(inputShape, meta);
    }

    const chunks = new Array<string>();
    const pathParts = new Map<string,string>();

    if (inputShape.spec.type !== 'structure') throw new Error(`REST Input wasn't a structure`);

    const locationTypes = new Set(Object.values(inputShape.spec.members).map(x => x.location ?? this.shapes.get(x).spec.location ?? 'body'));
    const hasBody = locationTypes.delete('body');
    const hasFraming = locationTypes.size > 0;

    const referencedInputs = new Set<string>();
    if (locationTypes.has('header') || locationTypes.has('headers')) {
      chunks.push(`    const headers = new Headers;`);
      referencedInputs.add('headers');
    }
    if (locationTypes.has('querystring')) {
      chunks.push(`    const query = new URLSearchParams;`);
      referencedInputs.add('query');
    }

    const framings = Object.entries(inputShape.spec.members).filter(x => x[1].location ?? this.shapes.get(x[1]).spec.location);
    for (const [field, spec] of framings) {
      const shape = this.shapes.get(spec);
      const defaultName = (field[0].toUpperCase()+field.slice(1));
      const locationName = spec.locationName ?? shape.spec.locationName ?? defaultName;
      let isRequired = (inputShape.spec.required ?? []).map(x => x.toLowerCase()).includes(field.toLowerCase());
      const paramRef = `params[${JSON.stringify(field)}]`;
      const fieldLocation = spec.location ?? shape.spec.location
      switch (fieldLocation) {
        case 'uri':
          // Store two copies to support toggling the url encoding
          switch (shape.spec.type) {
            case 'string':
              pathParts.set(`{${locationName}}`, `\${${paramRef}}`);
              pathParts.set(`{${locationName}+}`, `\${${paramRef}.split("/")}`);
              break;
            case 'integer':
            case 'double':
            case 'float':
            case 'long':
            case 'boolean':
              pathParts.set(`{${locationName}}`, `\${${paramRef}.toString()}`);
              break;
            default:
              throw new Error(`TODO: ${fieldLocation} ${shape.spec.type}`);
          }
          break;
        case 'header':
          let formattedRef = shape.spec.type == 'list' ? 'item' : paramRef;
          const headerShape = shape.spec.type == 'list' ? this.shapes.get(shape.spec.member) : shape;
          switch (headerShape.spec.type) {
            case 'timestamp': {
              const format  = spec.timestampFormat ?? headerShape.spec.timestampFormat ?? 'rfc822';
              formattedRef = `cmnP.serializeDate_${format}(${formattedRef})${format === 'unixTimestamp' ? '?.toString()' : ''} ?? ""`;
              this.helpers.useHelper("cmnP");
              break;
            }
            case 'integer':
            case 'double':
            case 'float':
            case 'long':
            case 'boolean':
              formattedRef = `${formattedRef}?.toString() ?? ''`;
              break;
            case 'blob':
              this.helpers.useHelper("serializeBlob");
              formattedRef = `serializeBlob(${formattedRef}) ?? ''`;
              break;
            case 'string':
              // TODO: also headers that are MD5s of other headers
              if (locationName === 'Content-MD5') {
                this.helpers.useHelper('hashMD5');
                formattedRef = `${formattedRef} ?? hashMD5(body ?? '')`;
                isRequired = true;
              } else if (spec.jsonvalue) {
                this.helpers.useHelper("jsonP");
                formattedRef = `btoa(jsonP.serializeJsonValue(${formattedRef}) ?? '')`;
                break;
              }
              break;
            default:
              throw new Error(`TODO: unhandled input header list type ${headerShape.spec.type}`);
            }
          if (shape.spec.type == 'list') {
            chunks.push(`    for (const item of ${paramRef} ?? []) {`);
            chunks.push(`      query.append(${JSON.stringify(locationName)}, ${formattedRef});`);
            chunks.push(`    }`);
          } else {
            chunks.push(`    ${isRequired ? '' : `if (${paramRef} != null) `}headers.append(${JSON.stringify(locationName)}, ${formattedRef});`);
          }
          break;
        case 'headers': {
          if (shape.spec.type !== 'map') throw new Error(`rest input headers not map`);
          chunks.push(`    for (const [key, val] of Object.entries(${paramRef} ?? {})) {`);

          const inner = this.shapes.get(shape.spec.value);
          switch (inner.spec.type) {
            case 'string':
              chunks.push(`      headers.append(${JSON.stringify(locationName)}+key, val ?? "");`);
              break;
            default:
              throw new Error(`rest input headers inner type ${inner.spec.type}`);
          }
          chunks.push(`    }`);
          break;
        }
        case 'querystring':
          switch (shape.spec.type) {
            case 'string':
              if (spec.jsonvalue) {
                this.helpers.useHelper("jsonP");
                chunks.push(`    ${isRequired ? '' : `if (${paramRef} != null) `}query.set(${JSON.stringify(spec.queryName ?? locationName)}, jsonP.serializeJsonValue(${paramRef}) ?? "");`);
                break;
              }
            case 'boolean':
            case 'integer':
            case 'double':
            case 'float':
            case 'long':
              chunks.push(`    ${isRequired ? '' : `if (${paramRef} != null) `}query.set(${JSON.stringify(spec.queryName ?? locationName)}, ${paramRef}?.toString() ?? "");`);
              break;
            case 'timestamp': {
              const format  = spec.timestampFormat ?? shape.spec.timestampFormat ?? 'iso8601';
              const helper = `cmnP.serializeDate_${format}`;
              this.helpers.useHelper("cmnP");
              chunks.push(`    ${isRequired ? '' : `if (${paramRef} != null) `}query.set(${JSON.stringify(spec.queryName ?? locationName)}, ${helper}(${paramRef})${format === 'unixTimestamp' ? '?.toString()' : ''} ?? "");`);
              break;
            }
            case 'list': {
              const inner = this.shapes.get(shape.spec.member);
              switch (inner.spec.type) {
                case 'string':
                case 'integer':
                  chunks.push(`    for (const item of ${paramRef}${isRequired ? '' : ' ?? []'}) {`);
                  chunks.push(`      query.append(${JSON.stringify(spec.queryName ?? locationName)}, item?.toString() ?? "");`);
                  chunks.push(`    }`);
                  break;
                default:
                  throw new Error(`TODO: ${fieldLocation} ${shape.spec.type} ${inner.spec.type} ${field}`);
              }
              break;
            }

            case 'map': {
              const inner = this.shapes.get(shape.spec.value);
              switch (inner.spec.type) {
                case 'string':
                  chunks.push(`    for (const [k,v] of Object.entries(${paramRef}${isRequired ? '' : ' ?? {}'})) {`);
                  chunks.push(`      query.append(k, v?.toString() ?? "");`);
                  chunks.push(`    }`);
                  break;
                case 'list':
                  chunks.push(`    for (const [k,v] of Object.entries(${paramRef}${isRequired ? '' : ' ?? {}'})) {`);
                  chunks.push(`      for (const item of v ?? []) {`);
                  chunks.push(`        query.append(k, item?.toString() ?? "");`);
                  chunks.push(`      }`);
                  chunks.push(`    }`);
                  break;
                default:
                  throw new Error(`TODO: ${fieldLocation} ${shape.spec.type} ${inner.spec.type} ${field}`);
              }
              break;
            }

            default:
              throw new Error(`TODO: ${fieldLocation} ${shape.spec.type} ${field}`);
          }
          break;
      }
    }

    if (hasBody) {
      let isFrame = true;
      let frame = inputShape;
      let frameRef = 'params';
      let locInfo: Schema.LocationInfo & {paramRef?: string} = meta;
      if (frame.spec.type !== 'structure') throw new Error(`BUG jgrhry`);
      let bodyFields = Object.entries(frame.spec.members).filter(x => !x[1].location)

      if (!locInfo.locationName && bodyFields.length === 1 && bodyFields[0][0] === inputShape.payloadField/*&& bodyFields[0][1].locationName*/) {
        const [bodyName, bodySpec] = bodyFields[0];
        const bodyShape = this.shapes.get(bodySpec);

        if (bodyShape.spec.type === 'blob' || bodyShape.spec.type === 'string') {
          isFrame = false;
          frameRef = `${frameRef}[${JSON.stringify(bodyName)}]`;
          chunks.splice(0, 0, `    const body = typeof ${frameRef} === 'string' ? new TextEncoder().encode(${frameRef}) : ${frameRef};`);
          referencedInputs.add(`body`);

        } else if (bodyShape.spec.type === 'structure') {
          frame = bodyShape;
          chunks.splice(0, 0, `    const inner = params[${JSON.stringify(bodyName)}];`)
          frameRef = `inner`;
          locInfo = {...bodySpec, paramRef: frameRef};

        } else throw new Error(`TODO: bad inner shape ${bodyShape.spec.type} ${bodyShape.name}`)

      } else {
        const frameSpec: Schema.ShapeStructure = {...inputShape.spec, members: {}};
        for (const [key, val] of bodyFields) {
          frameSpec.members[key] = val;
        }
        frame = new KnownShape(inputShape.name, frameSpec);
      }

      if (isFrame) {
        const innerCode = this.innerProtocol.generateOperationInputParsingTypescript(frame, locInfo);
        chunks.splice(1, 0, innerCode.inputParsingCode);
        for (const varr of innerCode.inputVariables) {
          referencedInputs.add(varr);
        }
      }
    }

    return {
      inputParsingCode: chunks.join('\n'),
      inputVariables: Array.from(referencedInputs),
      pathParts,
    };
  }
  generateOperationOutputParsingTypescript(shape: KnownShape, resultWrapper?: string, isNullBody?: boolean, streamingResponses?: boolean): { outputParsingCode: string; outputVariables: string[]; } {
    if (shape.spec.type !== 'structure') throw new Error(`todo agjijrs`);

    if (shape.spec.payload) {
      const payloadSpec = shape.spec.members[shape.spec.payload];
      if (!payloadSpec) throw new Error(`bug sywjyowgaa`);
      const payloadShape = this.shapes.get(payloadSpec);

      let payloadChunk = '';
      let payloadHeader = new Array<string>();
      if (payloadShape.spec.type === 'structure') {
        const bodyGen = this.innerProtocol.generateOperationOutputParsingTypescript(payloadShape, resultWrapper);
        const bodyGenLines = bodyGen.outputParsingCode.split('\n');
        const retLine = bodyGenLines.findIndex(x => x.match(/^ +return +/));
        const bodyGenReturns = bodyGenLines.slice(retLine).join('\n');
        payloadHeader = bodyGenLines.slice(0, retLine);
        payloadChunk = `${shape.spec.payload}: `+bodyGenReturns.replace(/^ +return +/, '').replace(/;$/, '').replace(/\n/g, '\n  ');
      } else if (payloadShape.spec.type === 'blob') {
        if (streamingResponses && (payloadSpec.streaming || payloadShape.spec.streaming)) {
          payloadChunk = `${shape.spec.payload}: resp.body`;
        } else {
          payloadChunk = `${shape.spec.payload}: new Uint8Array(await resp.arrayBuffer())`;
        }
      } else if (!isNullBody) {
        payloadHeader.push(`    await resp.body?.cancel();`);
      }

      const chunks = new Array<string>();
      chunks.push(`    return {`);
      for (const [field, spec] of Object.entries(shape.spec.members)) {
        if (spec === payloadSpec) continue;

        const isRequired = (shape.spec.required ?? []).map(x => x.toLowerCase()).includes(field.toLowerCase());
        chunks.push(this.describeOutputField(field, spec, isRequired).replace(/^/gm, '  '));

      }
      if (payloadChunk) chunks.push(`      ${payloadChunk},`);
      chunks.push(`    };`);
      return {
        outputParsingCode: [...payloadHeader, ...chunks].join('\n'),
        outputVariables: ['body'],
      };

    } else {
      const frameSpec: Schema.ShapeStructure = {...shape.spec, members: {}};

      const chunks = new Array<string>();
      chunks.push(`    return {`);
      let hasFraming = false;
      let hasBody = false;
      for (const [field, spec] of Object.entries(shape.spec.members)) {
        const fieldShape = this.shapes.get(spec);
        if (spec.location ?? fieldShape.spec.location) {
          const isRequired = (shape.spec.required ?? []).map(x => x.toLowerCase()).includes(field.toLowerCase());
          chunks.push(this.describeOutputField(field, spec, isRequired).replace(/^/gm, '  '));
          hasFraming = true;
        } else {
          frameSpec.members[field] = spec;
          hasBody = true;
        }
      }

      const frame = new KnownShape(shape.name, frameSpec);
      const bodyGen = this.innerProtocol.generateOperationOutputParsingTypescript(frame, resultWrapper);
      const bodyGenLines = bodyGen.outputParsingCode.split('\n');
      const retLine = bodyGenLines.findIndex(x => x.match(/^ +return +/));
      const bodyGenReturns = bodyGenLines.slice(retLine).join('\n');
      let payloadHeader = bodyGenLines.slice(0, retLine);
      const payloadChunk = bodyGenReturns.replace(/^ +return +/, '').replace(/;$/, '');

      if (payloadChunk === '{}') {
        payloadHeader = [];
        chunks.push(`    };`);
      } else if (!hasFraming) {
        chunks.pop();
        chunks.push(`    return ${payloadChunk};`);
      } else {
        hasBody = true;
        chunks.push(`      ...${payloadChunk.replace(/\n/g, '\n  ')},`);
        chunks.push(`    };`);
      }

      if (hasFraming && !hasBody && !isNullBody) {
        chunks.splice(0, 0, `    await resp.arrayBuffer(); // consume body without use`);
      }

      return {
        outputParsingCode: [...payloadHeader, ...chunks].join('\n'),
        outputVariables: bodyGen.outputVariables,
      };
    }
  }
  generateShapeInputParsingTypescript(shape: KnownShape): { inputParsingFunction: string; } {
    return this.innerProtocol.generateShapeInputParsingTypescript(shape);
  }
  generateShapeOutputParsingTypescript(shape: KnownShape): { outputParsingFunction: string; } {
    return this.innerProtocol.generateShapeOutputParsingTypescript(shape);
  }



  describeOutputField(field: string, spec: Schema.ShapeRef & Schema.StructureFieldDetails, isRequired: boolean): string {
    const namePrefix = (this.helpers.hasDep('s')) ? 's.' : '';
    const fieldShape = this.shapes.get(spec);
    switch (spec.location ?? fieldShape.spec.location) {
      case 'statusCode':
        return `    ${field}: resp.status,`;
      case 'header':
        switch (fieldShape.spec.type) {
          case 'timestamp':
            this.helpers.useHelper("cmnP");
            return `    ${field}: cmnP.read${isRequired ? 'Req' : ''}Timestamp(resp.headers.get(${JSON.stringify(spec.locationName || field)})),`;
          case 'string':
            if (fieldShape.spec.enum) {
              this.helpers.useHelper("cmnP");
              return `    ${field}: cmnP.readEnum<${namePrefix}${fieldShape.censoredName}>(resp.headers.get(${JSON.stringify(spec.locationName || field)})),`;
            } else if (spec.jsonvalue) {
              this.helpers.useHelper("jsonP");
              return `    ${field}: jsonP.readJsonValueBase64(resp.headers.get(${JSON.stringify(spec.locationName || field)})),`;
            } else {
              return `    ${field}: resp.headers.get(${JSON.stringify(spec.locationName || field)})${isRequired ? ' ?? ""' : ''},`;
            }
          case 'character':
            return `    ${field}: resp.headers.get(${JSON.stringify(spec.locationName || field)}),`;
          case 'integer':
          case 'double':
          case 'float':
          case 'long':
            this.helpers.useHelper("cmnP");
            return `    ${field}: cmnP.readNum(resp.headers.get(${JSON.stringify(spec.locationName || field)})),`;
          case 'boolean':
            this.helpers.useHelper("cmnP");
            return `    ${field}: cmnP.readBool(resp.headers.get(${JSON.stringify(spec.locationName || field)})),`;
          default:
            throw new Error(`TODO: rest output header ${fieldShape.spec.type} "${field}"`);
        }
      case 'headers':
        if (fieldShape.spec.type !== 'map') throw new Error(`rest headers field needs to be a Map`);
        const keyShape = this.shapes.get(fieldShape.spec.key);
        const valShape = this.shapes.get(fieldShape.spec.value);
        switch (valShape.spec.type) {
          case 'string':
            this.helpers.useHelper("cmnP");
            return `    ${field}: cmnP.toJsObj(resp.headers, ${spec.locationName ? JSON.stringify(spec.locationName.toLowerCase()) : 'true'}, v => v),`;
          default:
            throw new Error(`TODO: rest output headerS ${valShape.spec.type} "${field}"`);
        }
      default:
        throw new Error(`TODO: rest output location ${spec.location}`);
    }
  }
}
