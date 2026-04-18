// @ts-nocheck
const fs = require("fs");
const path = require("path");
const { compileProgram } = require("../compiler/index");
const { executeCompiledProgram } = require("../vm/index");
const { findWorkspaceRoot } = require("./paths");

const workspaceRoot = findWorkspaceRoot(__dirname);
const fixturesDir = path.join(workspaceRoot, "test", "vm-fixtures");
const manifest = require(path.join(workspaceRoot, "scripts", "vm-fixture-manifest.json"));

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
  const failures = [];

  for (const fixture of manifest) {
    const fixturePath = path.join(fixturesDir, fixture.file);
    const code = fs.readFileSync(fixturePath, "utf8");
    const logs = [];
    const compiled = await compileProgram(code, { sourceType: "module", filename: fixturePath });

    await executeCompiledProgram(compiled, {
      compiler: compileProgram,
      filename: fixturePath,
      env: {
        console: {
          log: (...args) => logs.push(args.join(" "))
        }
      }
    });

    const expected = JSON.stringify(fixture.logs);
    const actual = JSON.stringify(logs);
    if (expected !== actual) {
      failures.push(`${fixture.file}: expected ${expected}, got ${actual}`);
    }
  }

  if (failures.length > 0) {
    failures.forEach((failure) => console.log(failure));
    process.exitCode = 1;
    return;
  }

  console.log(`${manifest.length} VM smoke tests OK`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

export {};
