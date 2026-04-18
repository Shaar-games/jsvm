// @ts-nocheck
const { loadBindingValue } = require("../utils");

async function compileIdentifier(node, context) {
  return loadBindingValue(context, node.name);
}

module.exports = compileIdentifier;

export {};
