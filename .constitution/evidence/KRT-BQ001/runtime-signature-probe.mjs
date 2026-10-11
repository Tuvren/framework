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
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "typescript/kernel/runtime"));

function canonicalArraySpelling(signature) {
  const source = ts.createSourceFile("signature.ts", `declare const fn: ${signature};`, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(source, [(context) => {
    const visit = (node) => {
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isArrayTypeNode(node.type)) {
        return ts.factory.createTypeReferenceNode("ReadonlyArray", [ts.visitNode(node.type.elementType, visit)]);
      }
      if (ts.isArrayTypeNode(node)) {
        return ts.factory.createTypeReferenceNode("Array", [ts.visitNode(node.elementType, visit)]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  }]);
  const result = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  return result;
}

const originalSources = new Map();
for (const file of files) {
  const result = Bun.spawnSync(["git", "show", `${baselineCommit}:${file}`], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`Could not read ${file} at baseline ${baselineCommit}`);
  originalSources.set(resolve(root, file), result.stdout.toString());
}

function capture(useBaseline) {
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => useBaseline && originalSources.has(resolve(file)) ? originalSources.get(resolve(file)) : readFile(file);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const checker = program.getTypeChecker();
  const exports = {};
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature | ts.TypeFormatFlags.WriteArrayAsGenericType;
  for (const file of files) {
    const source = program.getSourceFile(resolve(root, file));
    if (!source) throw new Error(`Compiler program did not load ${file}`);
    const module = checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Compiler could not resolve module exports for ${file}`);
    for (const symbol of checker.getExportsOfModule(module)) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, source);
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((signature) =>
        canonicalArraySpelling(checker.signatureToString(signature, source, flags)));
      exports[`${file}:${symbol.name}`] = {
        type: canonicalArraySpelling(checker.typeToString(type, source, flags)),
        callSignatures: signatures,
      };
    }
  }
  return exports;
}

const before = capture(true);
const after = capture(false);
const beforeKeys = Object.keys(before).sort();
const afterKeys = Object.keys(after).sort();
const equal = JSON.stringify(beforeKeys) === JSON.stringify(afterKeys)
  && beforeKeys.every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
const callableCount = Object.values(before).reduce((sum, item) => sum + item.callSignatures.length, 0);
const result = { baselineCommit, files, exportedSymbolCount: beforeKeys.length, callableSignatureCount: callableCount, before, after, equal };
if (outputPath) await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`);

const relativeOutput = outputPath && (isAbsolute(outputPath) ? outputPath : relative(root, outputPath));
console.log(`${beforeKeys.length} exported symbols and ${callableCount} callable signatures compared against ${baselineCommit}; full export keys and signatures ${equal ? "match" : "differ"}${relativeOutput ? `; result written to ${relativeOutput}` : ""}`);
if (!equal) process.exitCode = 1;
