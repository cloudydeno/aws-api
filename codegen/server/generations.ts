import LatestCodeGen from '../lib/code-gen.ts';

import * as Schema from '../lib/sdk-schema.ts';

interface ApiSpecsBundle {
  api: Schema.Api;
  pagers?: Schema.Pagination;
  waiters?: Schema.Waiters;
  examples?: Schema.Examples;
}

interface CodeGen {
  generateTypescript(namespace: string): string;
  generateModTypescript(namespace: string): string;
  generateStructsTypescript(): string;
}

export class ModuleGenerator {
  constructor(
    public readonly sdkVersion: string,
    public readonly defaults: URLSearchParams,
    public readonly codegenConstr: (config: ApiSpecsBundle, opts: URLSearchParams) => CodeGen,
  ) {}

  withDefaults(options: URLSearchParams) {
    const newOpts = new URLSearchParams(options);
    for (const [option, value] of this.defaults) {
      if (!options.has(option)) {
        newOpts.append(option, value);
      }
    }
    return newOpts;
  }

  buildApi(opts: {
    apiSpecs: ApiSpecsBundle,
    options: URLSearchParams,
    className: string,
  }) {
    const fullOptions = this.withDefaults(opts.options);

    const codeGen = this.codegenConstr(opts.apiSpecs, fullOptions);
    return codeGen.generateTypescript(opts.className)
  }
}

// Newest versions come first
export const Generations = new Map<string, ModuleGenerator>([
  ['v0.1', new ModuleGenerator(
    'v2.895.0',
    new URLSearchParams([
      ['std_mod_root', 'https://deno.land/std@0.95.0'],
      ['aws_api_root', 'https://deno.land/x/aws_api@v0.4.0'],
      ['useJsr', 'no'],
      ['includeOpts', 'no'],
      ['includeJsonRemap', 'no'],
      ['includeClientExtras', 'no'],
      ['useAuthType', 'no'],
      ['alwaysReqLists', 'yes'],
      ['streamingResponses', 'no'],
      ['useImportMap', 'no'],
      ['docs', 'none'],
    ]),
    (config, opts) => new LatestCodeGen(config, opts),
  )],
  ['v0.2', new ModuleGenerator(
    'v2.971.0',
    new URLSearchParams([
      ['std_mod_root', 'https://deno.land/std@0.105.0'],
      ['aws_api_root', 'https://deno.land/x/aws_api@v0.5.0'],
      ['useJsr', 'no'],
      ['includeJsonRemap', 'no'],
      ['includeClientExtras', 'no'],
      ['useAuthType', 'no'],
      ['alwaysReqLists', 'yes'],
      ['streamingResponses', 'no'],
      ['useImportMap', 'no'],
      ['docs', 'none'],
    ]),
    (config, opts) => new LatestCodeGen(config, opts),
  )],
  ['v0.3', new ModuleGenerator(
    'v2.1060.0',
    new URLSearchParams([
      ['std_mod_root', 'https://deno.land/std@0.120.0'],
      ['aws_api_root', 'https://deno.land/x/aws_api@v0.6.0'],
      ['useJsr', 'no'],
      ['streamingResponses', 'no'],
      ['useImportMap', 'no'],
      ['docs', 'short'],
    ]),
    (config, opts) => new LatestCodeGen(config, opts),
  )],
  ['v0.4', new ModuleGenerator(
    'v2.1323.0',
    new URLSearchParams([
      ['std_mod_root', 'https://deno.land/std@0.177.0'],
      ['aws_api_root', 'https://deno.land/x/aws_api@v0.8.1'],
      ['useJsr', 'no'],
      ['useImportMap', 'no'],
      ['docs', 'short'],
    ]),
    (config, opts) => new LatestCodeGen(config, opts),
  )],
  ['v0.5', new ModuleGenerator(
    'v2.1692.0', // Final version before https://github.com/aws/aws-sdk-js reached EOL
    new URLSearchParams([
      ['aws_api_root', 'jsr:@cloudydeno/aws-api@0.9.0'],
      ['useImportMap', 'no'],
      ['docs', 'short'],
    ]),
    (config, opts) => new LatestCodeGen(config, opts),
  )],
]);
export const LatestGeneration = 'v0.5';
