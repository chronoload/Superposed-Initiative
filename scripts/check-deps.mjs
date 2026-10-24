import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const ALLOWED = {
  "@superpose/protocol": [],
  "@superpose/quantum": ["@superpose/protocol"],
  "@superpose/agent-core": ["@superpose/protocol", "@superpose/quantum"],
  "@superpose/mobile-suite": ["@superpose/protocol", "@superpose/quantum"],
  "@superpose/embody": [
    "@superpose/protocol",
    "@superpose/quantum",
    "@superpose/agent-core",
    "@superpose/mobile-suite",
  ],
  "@superpose/demo": [
    "@superpose/protocol",
    "@superpose/quantum",
    "@superpose/agent-core",
    "@superpose/mobile-suite",
    "@superpose/embody",
  ],
};

const PURE = new Set(["@superpose/protocol"]);
const FS_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

async function listDirs(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

async function listTs(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listTs(full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function specifiersOf(source) {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_PATTERN)) found.add(match[1]);
  return [...found];
}

function workspaceNameOf(specifier) {
  const parts = specifier.split("/");
  if (parts[0] !== "@superpose" || parts.length < 2) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

const errors = [];
const packages = new Map();

for (const dir of [...(await listDirs(path.join(ROOT, "packages"))), ...(await listDirs(path.join(ROOT, "apps")))]) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const name = manifest.name;
  const record = {
    name,
    dir,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    imports: new Set(),
  };
  packages.set(name, record);
  const src = path.join(dir, "src");
  for (const file of await listTs(src)) {
    const source = await readFile(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      const workspaceName = workspaceNameOf(specifier);
      if (workspaceName) record.imports.add(workspaceName);
      if (PURE.has(name) && FS_SPECIFIERS.has(specifier)) {
        errors.push(`${name} must stay pure but imports ${specifier} in ${path.relative(ROOT, file)}`);
      }
    }
  }
}

for (const [name, record] of packages) {
  const allowed = ALLOWED[name];
  if (!allowed) {
    errors.push(`unknown workspace package ${name} at ${path.relative(ROOT, record.dir)}`);
    continue;
  }
  if (record.dependencies.length > 0 && PURE.has(name)) {
    errors.push(`${name} must declare no dependencies, found: ${record.dependencies.join(", ")}`);
  }
  for (const dependency of record.dependencies) {
    if (!dependency.startsWith("@superpose/")) continue;
    if (!allowed.includes(dependency)) {
      errors.push(`${name} declares forbidden dependency ${dependency}`);
    }
  }
  for (const imported of record.imports) {
    if (!allowed.includes(imported)) {
      errors.push(`${name} imports forbidden package ${imported}`);
    }
  }
}

const graph = new Map();
for (const [name, record] of packages) {
  graph.set(name, new Set([...record.dependencies, ...record.imports].filter((dep) => dep.startsWith("@superpose/"))));
}

const state = new Map();
function visit(name, trail) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "active") {
    errors.push(`dependency cycle: ${[...trail, name].join(" -> ")}`);
    return;
  }
  state.set(name, "active");
  for (const next of graph.get(name) ?? []) visit(next, [...trail, name]);
  state.set(name, "done");
}
for (const name of graph.keys()) visit(name, []);

if (errors.length > 0) {
  for (const error of errors) console.error(`verify:deps FAIL ${error}`);
  process.exitCode = 1;
} else {
  console.log(`verify:deps OK (${packages.size} packages)`);
}
