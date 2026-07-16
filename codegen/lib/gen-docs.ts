import { parseXml, XmlNode } from "@cloudydeno/aws-api/encoding/xml.ts";

export function genDocsComment(docsXml: string, indentation: string, mode: 'short' | 'full') {
  const s = indentation;
  try {
    const {root} = parseXml(`<top>${docsXml}</top>`, true);
    const body = genBlock(root!, true).replace(/\*\//g, '*\\/');
    if (mode === 'short') {
      return `${s}/** ${body.split('\n')[0]} */`;
    }
    if (!body.includes('\n')) {
      return `${s}/** ${body} */`;
    }
    return `${s}/**\n${body.replace(/^/gm, `${s} * `).replace(/ +$/gm, '')}\n${s} */`;
  } catch (err: unknown) {
    return `${s}/** TODO: Failed to render documentation: ${(err as Error).message} */`;
  }
}

function genBlockOrPara(root: XmlNode) {
  // dumb heuristic
  const names = new Set(root.children.map(x => x.name));
  if (names.has('p') || names.has('ul') || names.has('ol')) {
    return genBlock(root);
  } else {
    return genParagraph(root);
  }
}

export function genBlock(root: XmlNode, isRoot = false) {
  const chunks = new Array<string>();
l:for (const top of root.children) {
    switch (top.name) {
      case '':
        if ((top.content || '').length < 3) continue l;
        chunks.push(`${top.content}`);
        break;
      case 'p':
      case 'div':
        if (top.attributes['class'] == 'seeAlso') {
          chunks.push('See also: '+genParagraph(top));
          break;
        }
        chunks.push(genParagraph(top));
        break;
      case 'ul':
        for (const child of top.children) {
          if (child.name === '') continue;
          if (child.name !== 'li') {
            // throw new Error(`unhandled ul tag ${child.name}`);
            continue;
          }
          chunks.push(`  - ${genBlockOrPara(child).split('\n').join('\n    ')}`);
        }
        break;
      case 'ol': {
        let idx = 1;
        for (const child of top.children) {
          if (child.name === '') continue;
          if (child.name !== 'li') {
            // throw new Error(`unhandled ol tag ${child.name}`);
            continue;
          }
          chunks.push(` ${idx++}. ${genBlockOrPara(child).split('\n').join('\n    ')}`);
        }
      } break;
      case 'dl':
        for (const child of top.children) {
          if (child.name === '') continue;
          if (child.name === 'dt') {
            chunks.push(`${genBlock(child)}:`.replace(/^/gm, `  `));
          } else if (child.name === 'dd') {
            chunks.push(genBlock(child).replace(/^/gm, `    `));
            chunks.push('');
          } else throw new Error(
            `unhandled dl tag ${child.name}`);
        }
        break;
      case 'important':
        chunks.push(`! IMPORTANT:`);
        chunks.push(genBlock(top).replace(/^/gm, `! `));
        break;
      case 'note':
        chunks.push(`  Note:`);
        chunks.push(genBlock(top).replace(/^/gm, `  `));
        break;
      case 'code':
        chunks.push(genBlock(top).replace(/^/gm, `    `));
        break;
      default:
        throw new Error(`unhandled top level doc tag ${top.name}`);
    }
    if (isRoot) chunks.push('');
  }

  return chunks.join('\n').trimEnd();
}

function genParagraph(node: XmlNode) {
  const pieces = new Array<string>();
  for (const top of node.children) {
    switch (top.name) {
      case '':
        pieces.push(top.content ?? '');
        break;
      case 'br':
        pieces.push('\n');
        break;
      case 'i':
      case 'em':
        pieces.push(`_${genParagraph(top)}_`);
        break;
      case 'b':
      case 'strong':
        pieces.push(`*${genParagraph(top)}*`);
        break;
      case 'a':
        const { href } = top.attributes;
        if (href) {
          pieces.push(`[${genParagraph(top).trim()}](${href})`);
        } else {
          pieces.push(`"${genParagraph(top).trim()}"`);
        }
        break;
      case 'code':
        pieces.push(`\`${genParagraph(top)}\``);
        // pieces.push(genParagraph(top).split('\n').map(x => `    *    ${x}`).join('\n'));
        break;

      // Things that shouldn't even be in a paragraph... 'es' does this
      case 'ul':
      case 'ol':
      case 'p':
        const fakeNode = new XmlNode('fakeNode');
        fakeNode.children.push(top);
        pieces.push(`\n${genBlock(fakeNode, false)}\n`);
        break;

      default:
        throw new Error(`unhandled paragraph inner tag ${top.name}`);
    }
  }
  return pieces.join('')
    .trim()
    .replace(/\)\n\./g, ').')
    .replace(/(\.`?) +/g, '$1\n')
    .replace(/, (see|go to) "/g, ',\n $1 "')
    .replace(/^\*([^*]+)\*$/, '\n## $1')
    .replace(/^\`([^`]+)\`$/, '    $1')
    .trimEnd();
}
