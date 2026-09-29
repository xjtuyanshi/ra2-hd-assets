import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Use the AST to check static/dynamic imports, re-exports, and type references without mistaking comments or ordinary strings for dependencies. */
function imports(source: string): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      result.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      result.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
/** String literals in code. The AST excludes comments, so explanatory prose is not treated as hardcoding. */
function stringLiterals(source: string): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) result.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(resolve(directory, entry.name))
      : /\.(mts|ts|tsx)$/.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  );
}
function dependency(file: string, specifier: string): string {
  if (specifier.startsWith('/src/')) return specifier.slice(1).split('?')[0]!;
  return specifier.startsWith('.')
    ? relative(resolve('.'), resolve(dirname(file), specifier))
        .replaceAll('\\', '/')
        .split('?')[0]!
    : specifier;
}

it('扫描器覆盖类型与动态导入，不误识别注释', () => {
  expect(
    imports(`import type { A } from '../../architecture/a'; export { b } from '../../architecture/b';
    const c = import('../../architecture/c'); type D = import('../../architecture/d').D; // import('../../architecture/fake')
    const text = "from '../../architecture/fake'";`),
  ).toEqual(['../../architecture/a', '../../architecture/b', '../../architecture/c', '../../architecture/d']);
});

it('通用 VM 不反向依赖游戏、应用、浏览器实现或 UI', () => {
  for (const file of walk(resolve('src/vm86')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
        /^(?:src\/(?:games|app|adapter|resources|platform|ui|server)\/|react(?:\/|$)|react-dom(?:\/|$)|relay-package(?:\/|$))/,
      );
    }
});

it('通用层不按游戏资源键或 EXE 名分支', () => {
  // The generic shim only consumes capabilities declared by gameProfile: page-title keys, EXE names, and dedicated DLL names
  // belong to individual game modules. Such literals in vm86 code indicate a layering bypass (comments are excluded).
  const forbidden = /^(?:campaignmenu|mainmenu|gui:[a-z]+|game\.exe|gamemd\.exe|ra2(?:md)?\.exe|xwis\.dll)$/i;
  for (const file of walk(resolve('src/vm86')))
    for (const literal of stringLiterals(readFileSync(file, 'utf8')))
      expect(literal, `${relative('.', file)} 出现游戏标识字面量`).not.toMatch(forbidden);
});

it('RA2 不引用 YR，YR 只按登记继承 RA2 的公共表', () => {
  // YR = RA2 + additions: spreading RA2's shared ABI and shim profile into YR is registered inheritance.
  // A reverse dependency would bring gamemd.exe-specific addresses into game.exe patches and direct-page startup paths.
  for (const file of walk(resolve('src/games/ra2')))
    for (const specifier of imports(readFileSync(file, 'utf8')))
      expect(dependency(file, specifier), `${relative('.', file)} → ${specifier}`).not.toMatch(/^src\/games\/yr\//);
  for (const file of walk(resolve('src/games/yr')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      // YR may inherit only RA2's shared ABI and shim profile. Other RA2 paths (direct-page startup,
      // patches, and probes) implement game.exe behavior and cannot be reused directly by gamemd.exe.
      if (target === 'src/games/ra2' || target.startsWith('src/games/ra2/'))
        expect(['src/games/ra2/abi', 'src/games/ra2/profile'], `${relative('.', file)} → ${specifier}`).toContain(
          target,
        );
    }
});

it('共享游戏契约不引用具体游戏模块', () => {
  // Contract modules at the top of src/games describe capabilities any game may implement (frame counters, runtime
  // hooks, render state, render passthrough). Game directories implement them, never the reverse: a contract that
  // reuses a game's types would make every other game (and the VM/Worker protocol) depend on that game. Checked
  // transitively through everything the contracts import inside src/games.
  const contracts = ['performance', 'renderPassthrough', 'renderState', 'runtimeHooks'].map(
    (name) => `src/games/${name}`,
  );
  const visited = new Set<string>();
  const pending = [...contracts];
  while (pending.length) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    const path = [`${module}.ts`, `${module}/index.ts`].map((candidate) => resolve(candidate)).find(existsSync);
    expect(path, `${module} 未找到`).toBeDefined();
    for (const specifier of imports(readFileSync(path!, 'utf8'))) {
      const target = dependency(path!, specifier);
      expect(target, `${module} → ${specifier}`).not.toMatch(/^src\/games\/(?:yr|ra2)(?:\/|$)/);
      if (target.startsWith('src/games/')) pending.push(target);
    }
  }
});

const DEV_FLAG = 'import.meta.env.DEV';

function isDevCondition(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isDevCondition(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return isDevCondition(node.left) || isDevCondition(node.right);
  return node.getText() === DEV_FLAG;
}

function onlyTypes(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/**
 * Module edges a production build keeps: value imports and re-exports, side-effect imports, `import()` and
 * `new URL(..., import.meta.url)` entries (Workers, worklets). Left out are type-only forms, which the TypeScript
 * transform erases, and anything lexically under an `import.meta.env.DEV` condition (if branch, `&&` right side,
 * `?:` true branch): Vite replaces the flag with `false` in production and Rollup drops the branch. A named import
 * used only as a type but written without `type` still counts; mark it `type` if a rule below flags it.
 */
function productionImports(source: string): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node, devOnly: boolean): void {
    if (ts.isIfStatement(node) && isDevCondition(node.expression)) {
      visit(node.expression, devOnly);
      visit(node.thenStatement, true);
      if (node.elseStatement) visit(node.elseStatement, devOnly);
      return;
    }
    if (ts.isConditionalExpression(node) && isDevCondition(node.condition)) {
      visit(node.condition, devOnly);
      visit(node.whenTrue, true);
      visit(node.whenFalse, devOnly);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isDevCondition(node.left)
    ) {
      visit(node.left, devOnly);
      visit(node.right, true);
      return;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const erased =
        clause?.isTypeOnly ||
        (clause && !clause.name && bindings && ts.isNamedImports(bindings) && onlyTypes(bindings.elements));
      if (!erased && !devOnly) result.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const erased = node.isTypeOnly || (clause && ts.isNamedExports(clause) && onlyTypes(clause.elements));
      if (!erased && !devOnly) result.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isImportTypeNode(node)) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      !devOnly
    ) {
      result.push(node.arguments[0].text);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[1]!.getText() === 'import.meta.url' &&
      !devOnly
    ) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, (child) => visit(child, devOnly));
  }
  visit(file, false);
  return result;
}

it('生产依赖扫描器跳过类型导入与开发期分支，保留 Worker 入口', () => {
  expect(
    productionImports(`import type { A } from './a'; import { type B } from './b'; import { C, type D } from './c';
    import './side'; export type { E } from './e'; export { F } from './f';
    type G = import('./g').G;
    if (import.meta.env.DEV) { void import('./dev-if'); }
    if (import.meta.env.DEV && flag) void import('./dev-and-if');
    const h = import.meta.env.DEV ? () => import('./dev-ternary') : () => import('./prod-ternary');
    const i = import.meta.env.DEV && import('./dev-and');
    if (!import.meta.env.DEV) void import('./negated');
    new Worker(new URL('./worker.ts', import.meta.url));`),
  ).toEqual(['./c', './side', './f', './prod-ternary', './negated', './worker.ts']);
});

it('生产构建不可达 HD 桥接的开发期模块', () => {
  // The HD bridge's YR render-state readers, overlay passthrough patches and the guest gate builder they use are
  // development-only (docs/remaster/HD_BRIDGE.md): src/games/yr/runtimeHooks.ts loads them only through dynamic
  // imports behind import.meta.env.DEV. One static import anywhere on the production graph (a shared constant, a
  // value-and-type import) would ship them again with nothing else failing, so walk that graph from the page entry
  // in index.html, through Worker and worklet entries, and require that none of them is reachable. Only src/ is
  // walked; packages are separate projects that must not reach back into the app.
  const devOnly =
    /^src\/games\/(?:yr\/(?:renderState|tacticalPassthrough|stateReader|buildingRenderState|infantryRenderState|shroudReader|effectsReader|overlayReader|smudgeReader)|shared\/guestGates)\.ts$/;
  const html = readFileSync('index.html', 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/([^"]+)"/g)].map((match) => match[1]!);
  expect(entries).toContain('src/main.ts');
  const from = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const pending = [...entries];
  const chain = (module: string): string => {
    const steps = [module];
    for (let at = from.get(module); at; at = from.get(at)) steps.unshift(at);
    return steps.join(' → ');
  };
  while (pending.length) {
    const module = pending.pop()!;
    expect(module, chain(module)).not.toMatch(devOnly);
    for (const specifier of productionImports(readFileSync(module, 'utf8'))) {
      const target = dependency(resolve(module), specifier);
      if (!target.startsWith('src/')) continue;
      const path = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx']
        .map((suffix) => `${target}${suffix}`)
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      expect(path, `${module} → ${specifier} 未找到`).toBeDefined();
      if (from.has(path!) || !/\.(?:[cm]?[jt]s|tsx)$/.test(path!)) continue;
      from.set(path!, module);
      pending.push(path!);
    }
  }
  // The walk must actually reach the Worker and the YR hooks, or the rule above proves nothing.
  for (const reached of ['src/adapter/vmWorker.ts', 'src/games/catalog.ts', 'src/games/yr/runtimeHooks.ts'])
    expect(from.has(reached), reached).toBe(true);
});

it('纯文件 provider 不依赖游戏识别、浏览器存储、VM 实现或 React', () => {
  for (const file of walk(resolve('src/resources/providers')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      // Guest path algorithms are pure functions; providers should not import the Win32 facade or shim state to use them.
      expect(target, `${relative('.', file)} → ${specifier}`).toMatch(
        /^src\/(?:resources\/(?:contracts$|providers\/)|vm86\/paths$)/,
      );
    }
  expect(imports(readFileSync('src/resources/contracts.ts', 'utf8'))).toEqual([]);
});

it('浏览器文件实现和游戏识别不回到 adapter 聚合层，也不依赖 UI', () => {
  for (const root of ['src/platform/browser/files', 'src/resources/discovery']) {
    for (const file of walk(resolve(root)))
      for (const specifier of imports(readFileSync(file, 'utf8'))) {
        const target = dependency(file, specifier);
        expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
          /^(?:src\/(?:adapter|ui|server)\/|react(?:\/|$))/,
        );
        if (root.endsWith('discovery')) expect(target).not.toMatch(/^src\/platform\//);
      }
  }
});

it('已迁出的聚合入口和游戏 ABI 不在通用层重建', () => {
  expect(existsSync('src/adapter/files.ts')).toBe(false);
  expect(readFileSync('src/vm86/win32.ts', 'utf8')).not.toMatch(
    /\b(?:RA2_ABI|YR_ABI|ra2Win32ArgBytes|yrWin32ArgBytes)\b/,
  );
  for (const file of walk(resolve('src')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      expect(dependency(file, specifier), file).not.toBe('src/adapter/files');
    }
});

it('会话控制与画面呈现不反向依赖 UI、具体游戏或模型实验', () => {
  for (const root of ['src/app/session', 'src/graphics']) {
    for (const file of walk(resolve(root)))
      for (const specifier of imports(readFileSync(file, 'utf8'))) {
        const target = dependency(file, specifier);
        expect(target, `${relative('.', file)} → ${specifier}`).not.toMatch(
          /^(?:src\/(?:ui|games|server)\/|react(?:\/|$)|onnxruntime-web(?:\/|$))/,
        );
      }
  }
  for (const file of walk(resolve('src/app/session')))
    for (const specifier of imports(readFileSync(file, 'utf8')))
      expect(dependency(file, specifier), `${relative('.', file)} → ${specifier}`).not.toMatch(
        /^src\/(?:adapter|platform)\//,
      );
  expect(existsSync('src/ui/pages/game/vmPageController.ts')).toBe(false);
});

it('VM 驱动只引用游戏来源类型，具体资源规则和 shim 由游戏组装层提供', () => {
  const path = resolve('src/adapter/vmCore.ts');
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const specifier of imports(source)) {
    if (dependency(path, specifier).startsWith('src/games/')) {
      expect(dependency(path, specifier)).toBe('src/games/source');
      expect(
        file.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === specifier &&
            node.importClause?.isTypeOnly,
        ),
      ).toBe(true);
    }
  }
  expect(source).not.toMatch(/withGameSpeedDefault|ra2NetworkEnabled|ra2NetworkRoom|ra2ExeHash|\/game\/ra2\//);
  for (const path of [
    'src/games/vmConfiguration.ts',
    'src/games/shared/vmConfiguration.ts',
    'src/games/shared/resourcePolicy.ts',
    'src/games/archivePolicy.ts',
  ]) {
    for (const specifier of imports(readFileSync(path, 'utf8'))) {
      expect(dependency(resolve(path), specifier)).not.toMatch(/^src\/(?:adapter|app|ui|server)\//);
    }
  }
});

it('relay package 不依赖应用，浏览器入口不能加载 Node 服务端', () => {
  const root = resolve('packages/relay');
  for (const file of walk(resolve(root, 'src')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      if (specifier.startsWith('.')) {
        expect(target, `${file} → ${specifier}`).toMatch(/^packages\/relay\/src\//);
        if (file.includes('/client/') || file.includes('/network/')) {
          expect(target, `${file} → ${specifier}`).toMatch(/^packages\/relay\/src\/(?:client|network)\//);
        }
      } else {
        expect(target).not.toMatch(/^(?:src\/|ra2-vm$|relay-package(?:\/|$))/);
        if (file.includes('/client/') || file.includes('/network/')) {
          throw new Error(`浏览器与协议模块不能加载服务端依赖：${file} → ${specifier}`);
        }
      }
    }
});

it('通用工具不反向依赖业务与平台模块', () => {
  for (const file of walk(resolve('src/utils')))
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const target = dependency(file, specifier);
      if (target.startsWith('src/')) expect(target, `${relative('.', file)} → ${specifier}`).toMatch(/^src\/utils\//);
    }
});
