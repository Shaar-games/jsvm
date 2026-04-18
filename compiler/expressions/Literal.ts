// @ts-nocheck
const { compileLiteralValue } = require("../utils");

async function compileLiteral(node, context) {
  return compileLiteralValue(node.value, context);
}

module.exports = compileLiteral;

export {};
