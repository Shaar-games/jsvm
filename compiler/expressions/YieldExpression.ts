// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, compileLiteralValue, emit, newRegister } = require("../utils");

async function compileYieldExpression(node, context) {
  if (!context.functionName) {
    throw new Error("YieldExpression used outside of a function context");
  }
  if (node.delegate) {
    const iterableRegister = await compileExpression(node.argument, context);
    const resumeValueRegister = newRegister(context);
    emit(context, [OpCode.YIELDSTAR, resumeValueRegister, iterableRegister]);
    return resumeValueRegister;
  }

  const yieldedValueRegister = node.argument
    ? await compileExpression(node.argument, context)
    : compileLiteralValue(undefined, context);
  const resumeValueRegister = newRegister(context);
  emit(context, [OpCode.YIELD, resumeValueRegister, yieldedValueRegister]);
  return resumeValueRegister;
}

module.exports = compileYieldExpression;

export {};
