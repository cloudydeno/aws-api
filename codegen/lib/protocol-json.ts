import type * as Schema from './sdk-schema.ts';
import type { ShapeLibrary, KnownShape } from "./shape-library.ts";
import type { HelperLibrary } from "./helper-library.ts";

export default class ProtocolJsonCodegen {
  constructor(
    public shapes: ShapeLibrary,
    public helpers: HelperLibrary,
    public flags: {
      includeJsonRemap: boolean;
    },
  ) {}

  generateOperationInputParsingTypescript(inputShape: KnownShape | null, meta: Schema.LocationInfo & {paramRef?: string}): { inputParsingCode: string; inputVariables: string[]; } {
    if (!inputShape) {
      return {
        inputParsingCode: `    const body: jsonP.JSONObject = {};`,
        inputVariables: ['body'],
      };
    }

    if (inputShape.spec.type !== 'structure') throw new Error(`BUG`);
    this.helpers.useHelper("jsonP");

    const paramRef = meta.paramRef ?? 'params';
    return {
      inputParsingCode: `    const body: jsonP.JSONObject = ${paramRef !== 'params' ? `${paramRef} ? ` : ''}${this.generateStructureInputTypescript(inputShape.spec, paramRef).replace(/\n/g, '\n  ')}${paramRef !== 'params' ? ` : {}` : ''};`,
      inputVariables: ['body'],
    };
  }
  generateShapeInputParsingTypescript(shape: KnownShape): { inputParsingFunction: string; } {
    if (shape.spec.type === 'string') return {
      inputParsingFunction: '',
    };
    this.helpers.useHelper("jsonP");

    const namePrefix = (this.helpers.hasDep('s')) ? 's.' : '';

    const chunks = new Array<string>();
    chunks.push(`function from${shape.censoredName}(input?: ${namePrefix}${shape.censoredName} | null): jsonP.JSONValue {`);

    switch (shape.spec.type) {
      case 'structure':
        chunks.push('  if (!input) return input;');
        chunks.push('  return '+this.generateStructureInputTypescript(shape.spec, 'input'));
        break;
      default:
        throw new Error(`TODO: protocol-json.ts lacks shape input generator for ${shape.spec.type}`);
    }

    chunks.push(`}`);
    return {
      inputParsingFunction: chunks.join('\n'),
    };
  }

  generateStructureInputTypescript(inputStruct: Schema.ShapeStructure, rootRef: string): string {
    const chunks = new Array<string>();
    chunks.push(`{`);
    for (const [field, spec] of Object.entries(inputStruct.members)) {
      const shape = this.shapes.get(spec);

      const fieldShape = this.shapes.get(spec);
      const locationName = this.ucfirst(spec.queryName) ?? spec.locationName ?? fieldShape.spec.locationName ?? field;

      const isList = shape.spec.type === 'list';
      const isMap = shape.spec.type === 'map';
      let innerShape = shape.spec.type === 'list'
        ? this.shapes.get(shape.spec.member)
        : shape.spec.type === 'map'
        ? this.shapes.get(shape.spec.value)
        : shape;
      let fieldRef = (isList || isMap) ? 'x' : `${rootRef}[${JSON.stringify(field)}]`;

      let encoder = '';
      if (innerShape.spec.type === 'timestamp') {
        const dateFmt = spec.timestampFormat ?? innerShape.spec.timestampFormat ?? 'unixTimestamp';
        this.helpers.useHelper("jsonP");
        encoder = `jsonP.serializeDate_${dateFmt}(${fieldRef})`;
      } else if (innerShape.spec.type === 'blob') {
        this.helpers.useHelper("serializeBlob");
        encoder = `serializeBlob(${fieldRef})`;
      } else if (innerShape.spec.type === 'structure') {
        encoder = `from${innerShape.censoredName}(${fieldRef})`;
      } else if (innerShape.spec.type === 'list') {
        const memShape = this.shapes.get(innerShape.spec.member);
        // if (innerShape.spec.member.jsonvalue) {
        //   encoder = `x.map(jsonP.serializeJsonValue)`;
        if (memShape.spec.type === 'structure' && memShape.tags.has('named')) {
          encoder = `x?.map(from${memShape.censoredName})`;
        }
      } else if (innerShape.spec.type === 'map') {
        const valShape = this.shapes.get(innerShape.spec.value);
        if (valShape.spec.type === 'structure' && valShape.tags.has('named')) {
          this.helpers.useHelper("jsonP");
          encoder = `jsonP.serializeMap(x, from${valShape.censoredName})`;
        }
      } else if (innerShape.spec.type === 'string' && (spec.jsonvalue || (fieldShape.spec.type === 'list' && fieldShape.spec.member.jsonvalue))) {
        this.helpers.useHelper("jsonP");
        encoder = `jsonP.serializeJsonValue(${fieldRef})`;
      } else if (innerShape.spec.type === 'string' && spec.idempotencyToken) {
        this.helpers.useHelper('generateIdemptToken');
        encoder = `${fieldRef} ?? generateIdemptToken()`;
      }

      const locationRef = locationName.match(/^[a-z0-9]+$/i) ? locationName : `${JSON.stringify(locationName)}`;
      if (encoder) {
        if (isList) {
          chunks.push(`    ${locationRef}: ${rootRef}[${JSON.stringify(field)}]?.map(x => ${encoder}),`);
        } else if (isMap) {
          this.helpers.useHelper("jsonP");
          chunks.push(`    ${locationRef}: jsonP.serializeMap(${rootRef}[${JSON.stringify(field)}], x => ${encoder}),`);
        } else {
          chunks.push(`    ${locationRef}: ${encoder},`);
        }
      } else {
        chunks.push(`    ${locationRef}: ${rootRef}[${JSON.stringify(field)}],`);
      }
    }
    chunks.push(`  }`);
    return chunks.join('\n');
  }


  generateOperationOutputParsingTypescript(shape: KnownShape, resultWrapper?: string): { outputParsingCode: string; outputVariables: string[]; } {
    if (shape.spec.type !== 'structure') throw new Error(
      `Can only generate top level output structures, not ${shape.spec.type}`);

    const chunks = new Array<string>();
    if (shape.refCount > 1) {
      chunks.push(`    return to${shape.censoredName}(await resp.json());`);
    } else {
      chunks.push('  '+this.generateStructureOutputTypescript(shape.spec, 'await resp.json()')
        .replace(/\n/g, '\n  '));
    }

    return {
      outputParsingCode: chunks.join('\n'),
      outputVariables: ['body'],
    };
  }

  generateShapeOutputParsingTypescript(shape: KnownShape): { outputParsingFunction: string; } {
    this.helpers.useHelper("jsonP");
    const namePrefix = (this.helpers.hasDep('s')) ? 's.' : '';

    const chunks = new Array<string>();
    const isStruct = shape.spec.type === 'structure';
    chunks.push(`function to${shape.censoredName}(root: jsonP.JSONValue): ${namePrefix}${shape.censoredName}${isStruct ? '' : ' | null'} {`);

    switch (shape.spec.type) {
      case 'structure':
        chunks.push(this.generateStructureOutputTypescript(shape.spec, 'root'));
        break;
      default:
        throw new Error(`TODO: protocol-json.ts lacks shape output generator for ${shape.spec.type}`);
    }

    chunks.push(`}`);
    return {
      outputParsingFunction: chunks.join('\n'),
    };
  }

  generateStructureOutputTypescript(outputStruct: Schema.ShapeStructure, rootRef: string): string {
    // Organize fields into basic strings and 'special' others
    // Basic strings can be passed directly from the xml module
    // TODO: support for locationName and maybe even enums, as further strings() arguments
    const required: {[key: string]: string | Symbol} = {};
    let hasRequired = false;
    const optional: {[key: string]: string | Symbol} = {};
    let hasOptional = false;
    const remap: {[key: string]: string} = {};
    const arrays = new Set<string>();

    this.helpers.useHelper("jsonP");
    const namePrefix = (this.helpers.hasDep('s')) ? 's.' : '';

    for (const [field, spec] of Object.entries(outputStruct.members)) {
      const isRequired = outputStruct.required?.includes(field);
      let typeSpec: string | Symbol | undefined;

      const fieldShape = this.shapes.get(spec);
      const locationName = spec.locationName ?? fieldShape.spec.locationName ?? field;

      if (fieldShape.spec.type === 'list') {
        arrays.add(field);
      }
      let innerShape = fieldShape.spec.type === 'list'
        ? this.shapes.get(fieldShape.spec.member)
        : fieldShape;

      if (innerShape.spec.type === 'string' && innerShape.spec.enum) {
        this.helpers.useHelper("cmnP");
        typeSpec = Symbol.for(`(x: jsonP.JSONValue) => cmnP.readEnum<${namePrefix}${innerShape.censoredName}>(x)`);
      } else if (innerShape.tags.has('named')) {
        typeSpec = Symbol.for('to'+innerShape.censoredName);
      } else if (innerShape.spec.type == 'string' && !innerShape.spec.enum) {
        if (spec.jsonvalue || (fieldShape.spec.type === 'list' && fieldShape.spec.member.jsonvalue)) {
          typeSpec = Symbol.for(`jsonP.readJsonValue`);
        } else {
          typeSpec = 's';
        }
      } else if (innerShape.isNumberType) {
        typeSpec = 'n';
      } else if (innerShape.spec.type == 'boolean') {
        typeSpec = 'b';
      } else if (innerShape.spec.type == 'blob') {
        typeSpec = 'a';
      } else if (innerShape.spec.type == 'timestamp') {
        typeSpec = 'd';
      } else if (innerShape.spec.type == 'character') {
        typeSpec = 's'; /// only used in test fixtures
      } else if (innerShape.spec.type == 'list') {
        const valShape = this.shapes.get(innerShape.spec.member);
        typeSpec = Symbol.for(`x => jsonP.readList(${this.exprReadOutput(valShape)}, x)`);
      } else if (innerShape.spec.type == 'map') {
        const keyShape = this.shapes.get(innerShape.spec.key);
        const valShape = this.shapes.get(innerShape.spec.value);
        const readKey = !keyShape.tags.has('named')
          ? 'String'
          : keyShape.spec.type === 'string'
          ? `x => cmnP.readEnumReq<${namePrefix}${keyShape.censoredName}>(x)`
          : 'String';
        const readVal = this.exprReadOutput(valShape);
        typeSpec = Symbol.for(`x => jsonP.readMap(${readKey}, ${readVal}, x)`);
        if (readKey.includes('cmnP.')) {
          this.helpers.useHelper("cmnP");
        }
      } else {
        throw new Error(`TODO: json output unknown field ${innerShape.spec.type}`);
      }

      if (!typeSpec) {
        throw new Error(`TODO: json output missed field ${innerShape.spec.type}`);
      }
      if (isRequired) {
        required[field] = typeSpec;
        hasRequired = true;
      } else {
        optional[field] = typeSpec;
        hasOptional = true;
      }
      if (locationName !== field) {
        remap[locationName] = field;
      }
    }

    const chunks = new Array<string>();
    chunks.push(`  return jsonP.readObj({`);

    if (hasRequired) {
      chunks.push(`    required: {`);
      for (const [key, spec] of Object.entries(required)) {
        const inner = typeof spec === 'symbol' ? spec.description : JSON.stringify(spec);
        const wrapped = arrays.has(key) ? `[${inner}]` : inner;
        chunks.push(`      ${JSON.stringify(key)}: ${wrapped},`);
      }
      chunks.push(`    },`);
    } else {
      chunks.push(`    required: {},`);
    }

    if (hasOptional) {
      chunks.push(`    optional: {`);
      for (const [key, spec] of Object.entries(optional)) {
        const inner = typeof spec === 'symbol' ? spec.description : JSON.stringify(spec);
        const wrapped = arrays.has(key) ? `[${inner}]` : inner;
        chunks.push(`      ${JSON.stringify(key)}: ${wrapped},`);
      }
      chunks.push(`    },`);
    } else {
      chunks.push(`    optional: {},`);
    }

    // feature flagged to not change v0.2 and lower
    if (this.flags.includeJsonRemap && Object.keys(remap).length > 0) {
      chunks.push(`    remap: ${JSON.stringify(remap)},`);
    }

    chunks.push(`  }, ${rootRef});`);
    return chunks.join('\n');
  }

  exprReadOutput(shape: KnownShape) {
    const isList = shape.spec.type === 'list';
    const innerShape = shape.spec.type === 'list'
      ? this.shapes.get(shape.spec.member)
      : shape;

    const namePrefix = (this.helpers.hasDep('s')) ? 's.' : '';

    let expr = 'TODO';
    if (innerShape.tags.has('named')) {
      if (innerShape.spec.type === 'string') {
        expr = `y => cmnP.readEnum<${namePrefix}${innerShape.censoredName}>(y)`;
        this.helpers.useHelper("cmnP");
      } else {
        expr = 'to'+innerShape.censoredName;
      }
    } else if (innerShape.isNumberType) {
      expr = 'Number';
    } else if (innerShape.spec.type === 'string') {
      expr = 'String';
    } else if (innerShape.spec.type === 'timestamp') {
      this.helpers.useHelper("jsonP");
      expr = 'jsonP.readDate';
    } else if (innerShape.spec.type === 'boolean') {
      expr = 'y => typeof y === "boolean" ? y : null';
    } else if (innerShape.spec.type === 'map') {
      this.helpers.useHelper("jsonP");
      const valShape = this.shapes.get(innerShape.spec.value);
      // TODO: is this safe? when would a map have a null?
      expr = `y => jsonP.readMap(String, ${this.exprReadOutput(valShape)}, y)!`;
    } else if (innerShape.spec.type === 'list') {
      this.helpers.useHelper("jsonP");
      const valShape = this.shapes.get(innerShape.spec.member);
      if (valShape.tags.has('named')) {
        // TODO: is this safe? when would an array have a null?
        expr = `y => jsonP.readList(to${valShape.censoredName}, y)!`;
      } else if (valShape.isNumberType) {
        // TODO: consider a separate readInt
        expr = `y => jsonP.readList(jsonP.readNum, y)!`;
      } else throw new Error(`TODO: json output list ${valShape.spec.type}`);
    }

    if (expr.includes('TODO')) throw new Error(`TODO: json output ${innerShape.spec.type}`);
    if (isList) {
      return `l => Array.isArray(l) ? l.map(${expr}) : []`;
    } else {
      return expr;
    }
  }

  ucfirst(name: string | undefined): string | undefined {
    if (!name) return name;
    return name[0].toUpperCase() + name.slice(1);
  }
}
