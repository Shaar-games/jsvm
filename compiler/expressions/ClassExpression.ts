// @ts-nocheck
const { compileClassDefinition } = require("../statements/ClassDeclaration");

async function compileClassExpression(node, context) {
  return compileClassDefinition(node, context, { bindName: false });
}

module.exports = compileClassExpression;

export {};
