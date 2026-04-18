// @ts-nocheck
const fs = require("fs");
const path = require("path");
const { compileProgram } = require("../compiler/index");
const { findWorkspaceRoot } = require("./paths");

const workspaceRoot = findWorkspaceRoot(__dirname);
const testDir = path.join(workspaceRoot, "test");
const snapshotsDir = path.join(testDir, "__bytecode_snapshots__");
const manifest = require(path.join(workspaceRoot, "scripts", "bytecode-snapshot-manifest.json"));
const updateMode = process.argv.includes("--update");

async function compileQuiet(code) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await compileProgram(code, { sourceType: "module" });
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const failures = [];

  for (const file of manifest) {
    const source = fs.readFileSync(path.join(testDir, file), "utf8");
    const compiled = await compileQuiet(source);
    const snapshot = compiled.join("\n") + "\n";
    const snapshotPath = path.join(snapshotsDir, `${file}.snap`);

    if (updateMode || !fs.existsSync(snapshotPath)) {
      fs.writeFileSync(snapshotPath, snapshot, "utf8");
      continue;
    }

    const expected = fs.readFileSync(snapshotPath, "utf8");
    if (expected !== snapshot) {
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    failures.forEach((file) => {
      console.log(`Snapshot mismatch: ${file}`);
    });
    process.exitCode = 1;
    return;
  }

  console.log(`${manifest.length} bytecode snapshots OK`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

export {};
