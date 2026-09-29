import ts from "typescript";

export interface Decl {
  path: string;
  start: number;
  end: number;
  norm: string;
  text: string;
  exported: boolean;
  leaf: boolean;
}

const KINDS = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) ||
  ts.isClassDeclaration(n) ||
  ts.isInterfaceDeclaration(n) ||
  ts.isTypeAliasDeclaration(n) ||
  ts.isEnumDeclaration(n) ||
  ts.isVariableStatement(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isPropertyDeclaration(n) ||
  ts.isPropertySignature(n) ||
  ts.isMethodSignature(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n) ||
  ts.isConstructorDeclaration(n);

function nameOf(n: ts.Node): string | undefined {
  const name = (n as any).name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)))
    return name.text;
  if (ts.isVariableStatement(n))
    return n.declarationList.declarations
      .map((d) => (ts.isIdentifier(d.name) ? d.name.text : "?"))
      .join(",");
  if (ts.isConstructorDeclaration(n)) return "constructor";
  return undefined;
}

const isExported = (n: ts.Node) =>
  !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);

/** Every named declaration, as a dotted path, with 1-based lines and its text with comments and whitespace stripped. */
export function declarations(text: string): Decl[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: Decl[] = [];
  const visit = (n: ts.Node, prefix: string, parentExported: boolean): boolean => {
    const name = nameOf(n);
    const isDecl = !!name && KINDS(n);
    const path = isDecl ? (prefix ? `${prefix}.${name}` : name!) : prefix;
    const exported = isDecl ? parentExported || isExported(n) : parentExported;
    let hasChild = false;
    const idx = out.length;
    if (isDecl) {
      const raw = n.getText(sf);
      out.push({
        path,
        exported,
        leaf: true,
        text: raw,
        start: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        end: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
        norm: raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, ""),
      });
    }
    ts.forEachChild(n, (c) => {
      if (visit(c, path, exported)) hasChild = true;
    });
    if (isDecl && hasChild) out[idx]!.leaf = false;
    return isDecl || hasChild;
  };
  visit(sf, "", false);
  return out;
}

/**
 * Reading units: top-level declarations and the members of classes, interfaces and object types.
 * Classes and interfaces are containers, not units; function bodies are never descended into, so a
 * local `const` does not split a method.
 */
export function units(text: string): Decl[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: Decl[] = [];
  const container = (n: ts.Node) => ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n);
  const add = (n: ts.Node, path: string, exported: boolean) => {
    const raw = n.getText(sf);
    out.push({
      path,
      exported,
      leaf: true,
      text: raw,
      start: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      end: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
      norm: raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, ""),
    });
  };
  for (const st of sf.statements) {
    const name = nameOf(st);
    if (!name || !KINDS(st)) continue;
    const exported = isExported(st);
    if (container(st)) {
      for (const m of (st as ts.ClassDeclaration | ts.InterfaceDeclaration).members) {
        const mn = nameOf(m);
        if (mn) add(m, `${name}.${mn}`, exported);
      }
    } else add(st, name, exported);
  }
  return out;
}
