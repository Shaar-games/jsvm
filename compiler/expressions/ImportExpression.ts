// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, newRegister } = require("../utils");

async function compileImportExpression(node, context) {
  const sourceRegister = await compileExpression(node.source, context);
  const resultRegister = newRegister(context);
  emit(context, [OpCode.IMPORT, resultRegister, sourceRegister, "dynamic"]);
  return resultRegister;
}

module.exports = compileImportExpression;

export {};
