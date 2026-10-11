import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

const root = process.cwd();
const baselineCommit = process.argv[2] ?? "b86053389235ed5c34a6896020a685f599eddce0";
const outputPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const ts = await import(`${root}/node_modules/typescript/lib/typescript.js`);

const files = [
  "typescript/kernel/runtime/src/lib/runtime-kernel-lineage.ts",
  "typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts",
  "typescript/kernel/runtime/src/lib/runtime-kernel-storage.ts",
  "typescript/kernel/runtime/src/lib/runtime-kernel.ts",
];
const configuration = resolve(root, "typescript/kernel/runtime/tsconfig.typecheck.json");
const config = ts.readConfigFile(configuration, ts.sys.readFile);
if (config.error) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "typescript/kernel/runtime"));

function canonicalTypeNode(node) {
  const transformed = ts.transform(node, [(context) => {
    const visit = (current) => {
      if (ts.isTypeOperatorNode(current) && current.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isArrayTypeNode(current.type)) {
        return ts.factory.createTypeReferenceNode("ReadonlyArray", [ts.visitNode(current.type.elementType, visit)]);
      }
      if (ts.isArrayTypeNode(current)) {
        return ts.factory.createTypeReferenceNode("Array", [ts.visitNode(current.elementType, visit)]);
      }
      return ts.visitEachChild(current, visit, context);
    };
    return (current) => ts.visitNode(current, visit);
  }]);
  const result = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], node.getSourceFile());
  transformed.dispose();
  return result;
}

function canonicalSignature(checker, signature, source) {
  const declaration = checker.signatureToSignatureDeclaration(
    signature,
    ts.SyntaxKind.FunctionType,
    source,
    ts.NodeBuilderFlags.NoTruncation,
  );
  if (declaration === undefined) {
    throw new Error("Compiler could not build a complete function type declaration");
  }
  if (!ts.isFunctionTypeNode(declaration)) {
    throw new Error("Compiler did not build a function type declaration");
  }
  return canonicalTypeNode(declaration);
}

function compareExports(before, after) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  return JSON.stringify(beforeKeys) === JSON.stringify(afterKeys)
    && beforeKeys.every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

function requireCheck(condition, description) {
  if (!condition) {
    throw new Error(`Probe self-check failed: ${description}`);
  }
}

function runSelfChecks() {
  const source = ts.createSourceFile(
    "signature-self-check.ts",
    "type ArrayForm = (value: string[]) => string[]; type GenericForm = (value: Array<string>) => Array<string>; type ChangedReturn = (value: Array<string>) => Array<number>;",
    ts.ScriptTarget.Latest,
    true,
  );
  requireCheck(source.parseDiagnostics.length === 0, "self-check fixtures parse without diagnostics");
  const [arrayForm, genericForm, changedReturn] = source.statements;
  if (!ts.isTypeAliasDeclaration(arrayForm)) {
    throw new Error("Compiler could not build the array-form self-check alias");
  }
  if (!ts.isTypeAliasDeclaration(genericForm)) {
    throw new Error("Compiler could not build the generic-form self-check alias");
  }
  if (!ts.isTypeAliasDeclaration(changedReturn)) {
    throw new Error("Compiler could not build the changed-return self-check alias");
  }
  requireCheck(canonicalTypeNode(arrayForm.type) === canonicalTypeNode(genericForm.type), "array spellings normalize equally");
  requireCheck(canonicalTypeNode(genericForm.type) !== canonicalTypeNode(changedReturn.type), "changed return types remain unequal");
  requireCheck(!compareExports({ "module:kept": "type" }, {}), "removing an export key fails comparison");
}

runSelfChecks();

const originalSources = new Map();
for (const file of files) {
  try {
    const source = execFileSync("git", ["show", `${baselineCommit}:${file}`], { cwd: root, encoding: "utf8" });
    originalSources.set(resolve(root, file), source);
  } catch (error) {
    throw new Error(`Could not read ${file} at baseline ${baselineCommit}`, { cause: error });
  }
}

function capture(useBaseline) {
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => useBaseline && originalSources.has(resolve(file)) ? originalSources.get(resolve(file)) : readFile(file);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const checker = program.getTypeChecker();
  const exports = {};
  for (const file of files) {
    const source = program.getSourceFile(resolve(root, file));
    if (!source) {
      throw new Error(`Compiler program did not load ${file}`);
    }
    const module = checker.getSymbolAtLocation(source);
    if (!module) {
      throw new Error(`Compiler could not resolve module exports for ${file}`);
    }
    for (const symbol of checker.getExportsOfModule(module)) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, source);
      const typeNode = checker.typeToTypeNode(type, source, ts.NodeBuilderFlags.NoTruncation);
      if (!typeNode) {
        throw new Error(`Compiler could not build the full type for ${file}:${symbol.name}`);
      }
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((signature) =>
        canonicalSignature(checker, signature, source));
      exports[`${file}:${symbol.name}`] = {
        type: canonicalTypeNode(typeNode),
        callSignatures: signatures,
      };
    }
  }
  return exports;
}

const before = capture(true);
const after = capture(false);
const equal = compareExports(before, after);
const exportedSymbolCount = Object.keys(before).length;
const callableCount = Object.values(before).reduce((sum, item) => sum + item.callSignatures.length, 0);
const result = { baselineCommit, files, exportedSymbolCount, callableSignatureCount: callableCount, before, after, equal };
if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

const relativeOutput = outputPath && (isAbsolute(outputPath) ? outputPath : relative(root, outputPath));
console.log(`${exportedSymbolCount} exported symbols and ${callableCount} callable signatures compared against ${baselineCommit}; full export keys and signatures ${equal ? "match" : "differ"}${relativeOutput ? `; result written to ${relativeOutput}` : ""}`);
if (!equal) {
  process.exitCode = 1;
}
