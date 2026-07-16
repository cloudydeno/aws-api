import type * as Schema from './sdk-schema.ts';
import type { ShapeLibrary, KnownShape, ShapeTag } from './shape-library.ts';
import type { HelperLibrary } from "./helper-library.ts";
import type { ProtocolCodegen } from "./protocol.ts";
import { genDocsComment } from "./gen-docs.ts";

export class StructEmitter {
  constructor(
    private apiSpec: Schema.Api,
    private shapes: ShapeLibrary,
    private helpers: HelperLibrary,
    private protocol: ProtocolCodegen,
    private namePrefix: string = '',
    private docMode: 'none' | 'short' | 'full',
    private alwaysReqLists: boolean,
    private streamingResponses: boolean,
  ) {}

  generateStructsTypescript(including: ('iface' | 'mapping')[]): string {
    const chunks = new Array<string>();

    for (const shape of this.shapes.allNamedShapes) {
      if (!shape.tags.has('named')) continue;
      if (shape.refCount < 1) continue;
      let anythingHappened = false;

      if (including.includes('iface')) {
        chunks.push(`// refs: ${shape.refCount
          } - tags: ${Array.from(shape.tags).join(', ')}`);

        if (shape.spec.documentation && (this.docMode != 'none')) {
          chunks.push(genDocsComment(shape.spec.documentation, '', this.docMode));
        }

        chunks.push(`${this.writeStructureType(shape)}`);

        anythingHappened = true;
      }

      // TODO: other types might want a helper func... enums??
      // TODO QUIRK: IdentityPool isn't tagged right, out of the entire API surface
      if (including.includes('mapping') && (shape.tags.has('interface') || shape.censoredName === 'IdentityPool')) {
        // Maybe include input reading (prep for wire)
        if (!(this.shapes.inputShapes.includes(shape) && shape.refCount === 1) && shape.tags.has('input')) {
          chunks.push(this.protocol.generateShapeInputParsingTypescript(shape).inputParsingFunction);
          anythingHappened = true;
        }
        // Maybe include output reading (post-wire enriching)
        if (!(this.shapes.outputShapes.includes(shape) && shape.refCount === 1) && shape.tags.has('output')) {
          chunks.push(this.protocol.generateShapeOutputParsingTypescript(shape).outputParsingFunction);
          anythingHappened = true;
        }
      }

      if (anythingHappened) {
        chunks.push('');
      }
    }

    return chunks.join('\n');
  }

  writeStructureType(shape: KnownShape): string {
    switch (shape.spec.type) {

      case 'structure':
        const required = new Set(shape.spec.required?.map(x => x.toLowerCase()) || []);
        // When possible, signal that our XML parser always fills in Array/Map properties
        const reqLists = shape.tags.has('output')
            && (this.alwaysReqLists || !shape.tags.has('input'))
            && !this.apiSpec.metadata.protocol.includes('json');

        return [`export interface ${shape.censoredName} {`,
          ...Object.entries(shape.spec.members).map(([key, spec]) => {
            const innerShape = this.shapes.get(spec);
            const isRequired = required.has(key.toLowerCase())
              || (reqLists && (innerShape.spec.type === 'list' || innerShape.spec.type === 'map'))
              || spec.location === 'uri';
            // Always supply a discoverability docstring for streaming response bodies
            const isBodyStream = this.streamingResponses && !shape.tags.has('input') && innerShape.spec.type == 'blob' && (spec.streaming || innerShape.spec.streaming);
            let doc = (this.docMode != 'none' && spec.documentation) ? `${genDocsComment(spec.documentation, '  ', this.docMode)}\n` : '';
            if (!doc && isBodyStream) doc = '  /** To get this stream as a buffer, use `new Response(...).arrayBuffer()` or related functions. */\n';
            // Emit the property
            return `${doc}  ${key}${isRequired ? '' : '?'}: ${this.specifyShapeType(innerShape, {isJson: spec.jsonvalue, tags: shape.tags, isBodyStream})}${isRequired ? '' : ' | null'};`;
          }),
        '}'].join('\n');

      case 'string':
        if (shape.spec.enum) {
          this.helpers.useHelper("cmnP");
          if (shape.name == 'InstanceType') {
            const byFam = shape.spec.enum.reduce((map, val) => {
              const fam = val.slice(0, val.indexOf('.'));
              if (!map.has(fam)) map.set(fam, []);
              map.get(fam)!.push(val);
              return map;
            }, new Map<string, string[]>())
            return [`export type ${shape.censoredName} =`,
              ...Array.from(byFam).map(value => value[1].map(x => `| ${JSON.stringify(x)}`).join(' ')),
            '| cmnP.UnexpectedEnumValue;'].join('\n');
          }
          return [`export type ${shape.censoredName} =`,
            ...shape.spec.enum.map(value => `| ${JSON.stringify(value)}`),
          '| cmnP.UnexpectedEnumValue;'].join('\n');
        }
        break;

    }
    return `// TODO: forgotten shape ${shape.name} of type ${shape.spec.type}\n`;
  }

  // TODO: enums as a map key type should become an object instead
  specifyShapeType(shape: KnownShape, opts: { isDictKey?: true; isJson?: true, tags?: Set<ShapeTag>, isBodyStream?: boolean }): string {
    if (shape.tags.has('named') && !opts.isDictKey) {
      return this.namePrefix+shape.censoredName;
    }

    switch (shape.spec.type) {
      case 'string':
        if (shape.spec.enum && !opts.isDictKey) {
          return shape.spec.enum.map(x => JSON.stringify(x)).join(' | ');
        } else if (opts.isJson && !opts.isDictKey) {
          this.helpers.useHelper("jsonP");
          return 'jsonP.JSONValue';
        }
      case 'boolean':
        return shape.spec.type;
      case 'character':
        return 'string';
      case 'double':
      case 'float':
      case 'long':
      case 'integer':
        return 'number';
      case 'list':
        const memberShape = this.shapes.get(shape.spec.member);
        let memberType = this.specifyShapeType(memberShape, {isJson: shape.spec.member.jsonvalue, tags: opts.tags ?? shape.tags});
        if (memberType.includes(' ')) memberType = `(${memberType})`;
        return `${memberType}[]`;
      case 'map':
        const keyShape = this.shapes.get(shape.spec.key);
        const valueShape = this.shapes.get(shape.spec.value);
        const keyType = (keyShape.spec.type === 'string' && keyShape.spec.enum)
          ? `key in ${this.namePrefix}${keyShape.censoredName}`
          : `key: ${this.specifyShapeType(keyShape, {isDictKey: true, tags: opts.tags ?? shape.tags})}`;
        return `{ [${keyType}]: ${this.specifyShapeType(valueShape, {isJson: shape.spec.value.jsonvalue, tags: opts.tags ?? shape.tags})} | null | undefined }`;
      case 'structure':
        return this.writeStructureType(shape).replace(/\n/g, '\n  ');
      case 'timestamp':
        return 'Date | number';
      case 'blob':
        if (this.streamingResponses) {
          if (opts.tags?.has('input')) {
            // if (opts.isBodyStream) throw new Error(`TODO: streaming inputs? (${shape.name})`);
            return 'Uint8Array | string'; // used for inputs, so let's accept a union
          }
          if (opts.isBodyStream) return 'ReadableStream<Uint8Array>';
          return 'Uint8Array'; // only used for outputs, we will always give bytes
        } else {
          // Legacy logic for codegen v0.3 and earlier
          if (opts.tags?.has('output') && !opts.tags?.has('input')) {
            return 'Uint8Array';
          }
          return 'Uint8Array | string';
        }
      default:
        console.log('TODO:', shape);
        throw new Error(`TODO: unimpl shape type ${(shape as any).spec.type}`);
    }
  }

}
