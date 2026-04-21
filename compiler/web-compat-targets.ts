// @ts-nocheck
const { compileExpression } = require("./dispatch/expressions");
const { OpCode, emit, loadBindingValue, newRegister } = require("./utils");

function isWebCompatCallAssignmentTarget(node, context) {
  return Boolean(
    node
    && node.type === "CallExpression"
    && context.options.sourceType === "script"
  );
}

async function emitWebCompatCallAssignmentReferenceError(node, context) {
  await compileExpression(node, context);

  const referenceErrorCtorRegister = loadBindingValue(context, "ReferenceError");
  const thrownValueRegister = newRegister(context);
  emit(context, [OpCode.NEW, thrownValueRegister, referenceErrorCtorRegister, 0]);
  emit(context, [OpCode.THROW, thrownValueRegister]);
  return thrownValueRegister;
}

module.exports = {
  isWebCompatCallAssignmentTarget,
  emitWebCompatCallAssignmentReferenceError,
};

export {};
