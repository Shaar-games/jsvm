// @ts-nocheck
function parseBytecode(bytecode) {
  const labels = new Map();
  const instructions = [];

  for (const line of bytecode) {
    if (line.length === 1 && typeof line[0] === "string" && line[0].endsWith(":")) {
      labels.set(line[0].slice(0, -1), instructions.length);
      continue;
    }
    defineOwnArrayElement(instructions, line);
  }

  return { instructions, labels };
}

function defineOwnArrayElement(array, value) {
  Object.defineProperty(array, array.length, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function buildFunctionTable(functions, table = new Map()) {
  for (const fn of functions || []) {
    table.set(fn.id, fn);
    buildFunctionTable(fn.functions || [], table);
  }
  return table;
}

module.exports = {
  buildFunctionTable,
  parseBytecode,
};

export {};
