import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const requiredMajor = 24;
const actualMajor = Number(process.versions.node.split(".")[0]);
if (process.platform !== "win32") {
  throw new Error("The current desktop package target requires a Windows Node runtime.");
}
if (!Number.isFinite(actualMajor) || actualMajor < requiredMajor) {
  throw new Error(`Packaging the local backend requires Node ${requiredMajor}+; found ${process.version}.`);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = path.resolve(scriptDirectory, "..", ".local-backend-runtime");
const targetExecutable = path.join(runtimeDirectory, "node.exe");

fs.mkdirSync(runtimeDirectory, { recursive: true });
fs.copyFileSync(process.execPath, targetExecutable);
console.log(`Prepared bundled local-backend runtime: ${targetExecutable} (${process.version})`);
