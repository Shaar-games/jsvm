// @ts-nocheck
const fs = require("fs");
const path = require("path");

function findWorkspaceRoot(startDir) {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    const testDirPath = path.join(currentDir, "test");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(testDirPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not locate workspace root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

module.exports = {
  findWorkspaceRoot,
};

export {};
