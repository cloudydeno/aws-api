import type * as Schema from './sdk-schema.ts';

export class ShapeLibrary {

  static fromApiSpec(apiSpec: Schema.Api): ShapeLibrary {
    const inputShapes = new Set<string>();
    const outputShapes = new Set<string>();
    for (const op of Object.values(apiSpec.operations)) {
      if (op.input) inputShapes.add(op.input.shape);
      if (op.output) outputShapes.add(op.output.shape);
    }

    return new ShapeLibrary({
      shapeSpecs: apiSpec.shapes,
      inputNames: Array.from(inputShapes),
      outputNames: Array.from(outputShapes),
    });
  }

  knownShapes: Map<string, KnownShape>;

  inputShapes: Array<KnownShape>;
  outputShapes: Array<KnownShape>;
  inputInnerShapes: Array<KnownShape>;
  outputInnerShapes: Array<KnownShape>;
  allNamedShapes: Set<KnownShape>;

  constructor({
    shapeSpecs,
    inputNames,
    inputInnerNames = [],
    outputNames,
    outputInnerNames = [],
  }: {
    shapeSpecs: {[name: string]: Schema.ApiShape},
    inputInnerNames?: string[],
    outputInnerNames?: string[],
    inputNames: string[],
    outputNames: string[],
  }) {
    this.knownShapes = new Map;
    for (const [name, spec] of Object.entries(shapeSpecs)) {
      this.knownShapes.set(name, new KnownShape(name, spec));
    }

    this.inputShapes = inputNames.map(x => this.knownShapes.get(x)).filter((x): x is KnownShape => !!x);
    this.outputShapes = outputNames.map(x => this.knownShapes.get(x)).filter((x): x is KnownShape => !!x);
    this.inputInnerShapes = inputInnerNames.map(x => this.knownShapes.get(x)).filter((x): x is KnownShape => !!x);
    this.outputInnerShapes = outputInnerNames.map(x => this.knownShapes.get(x)).filter((x): x is KnownShape => !!x);

    const allNamedShapes = new Set<KnownShape>([
      ...this.inputShapes, ...this.inputInnerShapes,
      ...this.outputShapes, ...this.outputInnerShapes,
    ]);
    const visitShape = (ref: Schema.ShapeRef, tagWith: ShapeTag) => {
      const shape = this.get(ref);
      shape.refCount++;
      shape.tags.add(tagWith);
      if (shape.spec.type === 'structure') {
        allNamedShapes.add(shape);
        shape.tags.add('named');
        shape.tags.add('interface');
      } else if (shape.spec.type === 'string' && shape.spec.enum) {
        allNamedShapes.add(shape);
        shape.tags.add('named');
        shape.tags.add('enum');
      }
    };

    for (const shape of this.inputShapes) {
      shape.refCount++;
      shape.tags.add('named');
      shape.tags.add('input');
      this.visitAllShapesDeep(shape, ref => visitShape(ref, 'input'));
    }
    for (const shape of this.inputInnerShapes) {
      shape.tags.add('input');
    }

    for (const shape of this.outputShapes) {
      shape.refCount++;
      shape.tags.add('named');
      shape.tags.add('output');
      this.visitAllShapesDeep(shape, ref => visitShape(ref, 'output'));

      if (shape.payloadField && shape.spec.type == 'structure') {
        const payloadSpec = this.get(shape.spec.members[shape.payloadField]);
        if (payloadSpec.spec.eventstream) shape.tags.add('eventstream');
      }
    }
    for (const shape of this.outputInnerShapes) {
      shape.tags.add('output');
    }

    this.allNamedShapes = allNamedShapes;
  }

  get(ref: Schema.ShapeRef): KnownShape {
    const shape = this.knownShapes.get(ref.shape);
    if (!shape) throw new Error(`BUG: shape ref ${ref.shape} didn't resolve`);
    return shape;
  }



  visitAllShapesDeep(shape: KnownShape, visit: (ref: Schema.ShapeRef) => void, stack: KnownShape[]=[]) {
    const consider = (ref: Schema.ShapeRef) => {
      const child = this.get(ref);
      if (stack.includes(child)) {
        child.refCount++; // keep it named
        child.tags.add('recursed');
        shape.tags.add('recursive');
        return;
      }
      stack.push(child);
      visit(ref);
      this.visitAllShapesDeep(child, visit, stack);
      stack.pop();
    }

    switch (shape.spec.type) {
      case 'structure':
        Object.values(shape.spec.members).forEach(consider);
        break;
      case 'map':
        consider(shape.spec.key);
        consider(shape.spec.value);
        break;
      case 'list':
        consider(shape.spec.member);
        break;
    }
  }

};

export type ShapeTag =
| 'named'
| 'interface' | 'enum'
| 'input' | 'output'
| 'recursed' | 'recursive'
| 'eventstream'
;

export class KnownShape {
  constructor(
    public name: string,
    public spec: Schema.ApiShape,
  ) {
    this.payloadField = this.spec.payload;
  }
  payloadField?: string;
  tags = new Set<ShapeTag>();
  refCount = 0;

  get censoredName(): string {
    if (['Object', 'Date', 'String'].includes(this.name))
      return '_'+this.name;
    return this.name;
  }

  get isNumberType() {
    return ['integer', 'float', 'double', 'long'].includes(this.spec.type);
  }

}
