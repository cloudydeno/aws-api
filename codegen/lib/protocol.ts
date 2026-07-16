import type * as Schema from './sdk-schema.ts';
import { ShapeLibrary, KnownShape } from './shape-library.ts';
import { HelperLibrary } from "./helper-library.ts";

import ProtocolQueryCodegen from './protocol-query.ts';
import ProtocolJsonCodegen from './protocol-json.ts';
import ProtocolRestCodegen from "./protocol-rest.ts";
import ProtocolXmlCodegen from "./protocol-xml.ts";

export interface ProtocolCodegen {
  generateOperationInputParsingTypescript(
    inputShape: KnownShape | null,
    meta: Schema.LocationInfo,
  ): {
    inputParsingCode: string;
    inputVariables: string[];
    pathParts?: Map<string,string>;
  };

  generateOperationOutputParsingTypescript(
    shape: KnownShape,
    resultWrapper?: string,
    isNullBody?: boolean,
    streamingResponses?: boolean,
  ): {
    outputParsingCode: string;
    outputVariables: string[];
  };

  generateShapeInputParsingTypescript(
    shape: KnownShape,
  ): {
    inputParsingFunction: string;
  };

  generateShapeOutputParsingTypescript(
    shape: KnownShape,
  ): {
    outputParsingFunction: string;
  };
}

export function makeProtocolCodegenFor(
  metadata: Schema.ApiMetadata,
  shapes: ShapeLibrary,
  helpers: HelperLibrary,
  flags: {includeJsonRemap?: boolean}
) {
  switch (metadata.protocol) {

    case 'ec2':
      return new ProtocolQueryCodegen(shapes, helpers, {ec2: true});
    case 'query':
      return new ProtocolQueryCodegen(shapes, helpers);

    case 'json':
      return new ProtocolJsonCodegen(shapes, helpers, {
        includeJsonRemap: flags.includeJsonRemap ?? true,
      });

    case 'rest-xml': {
      const inner = new ProtocolXmlCodegen(shapes, helpers);
      return new ProtocolRestCodegen(inner);
    }

    case 'rest-json': {
      const inner = new ProtocolJsonCodegen(shapes, helpers, {
        includeJsonRemap: flags.includeJsonRemap ?? true,
      });
      return new ProtocolRestCodegen(inner);
    }

    default: throw new Error(
      `TODO: unimpl protocol ${metadata.protocol}`);
  }
}
