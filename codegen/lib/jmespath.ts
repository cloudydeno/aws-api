import { compile, type ASTNode, Token } from '@cloudydeno/jmespath';

export function compileJMESPath(pathstr: string, rootRef: string): string {
  return postProcess(compilePath(compile(pathstr), rootRef));
}

function postProcess(code: string): string {
  return code
    .replace(/\.flat\(\)\.map/g, '.flatMap')
    .replace(/\?\.flat\(\)/g, '')
  ;
}

function compilePath(root: ASTNode, rootRef: string): string {

  function assertChildCount(children: unknown[], count: number) {
    if (children.length !== count) throw new Error(
      `BUG: ${root.type} had ${children.length} children`);
  }

  switch (root.type) {

    case 'Field':
      return `${rootRef}?.${root.name}`;

    case 'Subexpression': {
      let expr = rootRef;
      for (const child of root.children) {
        if (!child || typeof child !== 'object') throw new Error(
          `BUG: Subexpression child wasn't an ASTNode`);
        expr = compilePath(child, expr);
      }
      return expr;
    }

    case 'Literal':
      return JSON.stringify(root.value);

    case 'NotExpression': {
      assertChildCount(root.children, 1);
      const [base] = root.children;
      if (!base || typeof base !== 'object') throw new Error(
        `BUG: NotExpression base wasn't an ASTNode`);
      return `!(${compilePath(base, rootRef)})`;
    }

    case 'AndExpression': {
      return (root.children as ASTNode[])
        .map(child => compilePath(child, rootRef))
        .join(' && ');
    }

    case 'Comparator': {
      assertChildCount(root.children, 2);
      const operators: {[key: string]: string} = {
        [Token.TOK_GT]:  '>',
        [Token.TOK_GTE]: '>=',
        [Token.TOK_LT]:  '<',
        [Token.TOK_LTE]: '<=',
        [Token.TOK_EQ]:  '==',
      };
      const operator = operators[root.name];
      if (!operator) throw new Error(
        `BUG: Comparator operator ${root.name} not mapped to JS`);
      return `${compilePath(root.children[0], rootRef)} ${operator} ${compilePath(root.children[1], rootRef)}`;
    }

    case 'Function': {
      switch (root.name) {

        case 'length':
          if (root.children.length !== 1) throw new Error(
            `BUG: Function 'length' had ${root.children.length} children`);
          return `(${compilePath(root.children[0], rootRef).replace(/\?$/, '')} || '').length`;

      }
      break;
    }

    case Token.TOK_FLATTEN: {
      assertChildCount(root.children, 1);
      const [source] = root.children;
      if (!source || typeof source !== 'object') throw new Error(
        `BUG: Projection base wasn't an ASTNode`);
      // TODO: not sure this is even necesary??
      return `${compilePath(source, rootRef)}?.flat()`;
      // return compilePath(source, rootRef);
    }

    case 'Projection': {
      assertChildCount(root.children, 2);
      const [base, mapper] = root.children;
      if (!base || typeof base !== 'object') throw new Error(
        `BUG: Projection base wasn't an ASTNode`);
      if (!mapper || typeof mapper !== 'object') throw new Error(
        `BUG: Projection mapper wasn't an ASTNode`);
      switch (mapper.type) {

        case 'Identity':
          return compilePath(base, rootRef);

        case 'Subexpression':
        case 'Field':
          return `${compilePath(base, rootRef)}.map(x => ${compilePath(mapper, 'x')})`;

      }
      break;
    }

    case 'ValueProjection': {
      assertChildCount(root.children, 2);
      const [base, mapper] = root.children;
      if (!base || typeof base !== 'object') throw new Error(
        `BUG: ValueProjection base wasn't an ASTNode`);
      if (!mapper || typeof mapper !== 'object') throw new Error(
        `BUG: ValueProjection mapper wasn't an ASTNode`);

      const valuesExpr = `Object.values(${compilePath(base, rootRef)})`;
      switch (mapper.type) {

        case 'Identity':
          return valuesExpr;

        case 'Subexpression':
        case 'Field':
          return `${valuesExpr}.map(x => ${compilePath(mapper, 'x')})`;

      }
      break;
    }

    case 'FilterProjection': {
      assertChildCount(root.children, 3);
      const [base, mapper, filter] = root.children;
      if (!base || typeof base !== 'object') throw new Error(
        `BUG: FilterProjection base wasn't an ASTNode`);
      if (!mapper || typeof mapper !== 'object') throw new Error(
        `BUG: FilterProjection mapper wasn't an ASTNode`);
      if (!filter || typeof filter !== 'object') throw new Error(
        `BUG: FilterProjection filter wasn't an ASTNode`);
      let expr = compilePath(base, rootRef);

      if (filter.type !== 'Identity') {
        expr += `?.filter(x => ${compilePath(filter, 'x')})`;
      }

      if (mapper.type !== 'Identity') {
        expr += `?.map(x => ${compilePath(mapper, 'x')}).filter(x => x)`;
      }

      return expr;
    }

  }
  return `void /* TODO: ${JSON.stringify(root, null, 2)} */`;
}
