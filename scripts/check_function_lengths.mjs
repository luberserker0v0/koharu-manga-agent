import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "../gui/node_modules/typescript/lib/typescript.js";

const root = path.resolve(import.meta.dirname, "..");
const limit = Number(process.argv[2] || 30);
const roots = [path.join(root, "backend", "src"), path.join(root, "gui", "src")];
const extensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return extensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

function scriptKind(filePath) {
  const kinds = {
    ".js": ts.ScriptKind.JS,
    ".jsx": ts.ScriptKind.JSX,
    ".ts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
  };
  return kinds[path.extname(filePath)];
}

function functionName(node, sourceFile, line) {
  if (node.name?.getText(sourceFile)) return node.name.getText(sourceFile);
  if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile);
  return `<anonymous@${line}>`;
}

function inspectFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const diagnostics = sourceFile.parseDiagnostics.map((diagnostic) => {
    const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start || 0);
    return `${path.relative(root, filePath)}:${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
  const violations = [];
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getStart(sourceFile), node.end - 1)).line + 1;
      if (end - start + 1 > limit) {
        violations.push({
          filePath,
          name: functionName(node, sourceFile, start),
          start,
          end,
          lines: end - start + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { diagnostics, violations };
}

const results = roots.flatMap(sourceFiles).map(inspectFile);
const diagnostics = results.flatMap((result) => result.diagnostics);
const violations = results.flatMap((result) => result.violations).sort((left, right) => right.lines - left.lines);
for (const diagnostic of diagnostics) console.error(`syntax: ${diagnostic}`);
for (const item of violations) {
  console.log(`${path.relative(root, item.filePath)}:${item.start} ${item.name} (${item.lines} lines)`);
}
console.log(
  `Checked ${results.length} files: ${violations.length} function(s) exceed ${limit} lines; ${diagnostics.length} syntax error(s).`,
);
if (violations.length || diagnostics.length) process.exitCode = 1;
