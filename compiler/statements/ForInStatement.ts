// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { pushScope, popScope } = require("../context");
const { OpCode, compileLiteralValue, emit, emitLabel, initializeBinding, loadBindingValue, makeLabel, newRegister, popControlLabel, pushControlLabel, storeBindingValue } = require("../utils");
const {
  emitWebCompatCallAssignmentReferenceError,
  isWebCompatCallAssignmentTarget,
} = require("../web-compat-targets");

async function compileForInStatement(node, context) {
  const objectRegister = await compileExpression(node.right, context);
  const objectCtorRegister = loadBindingValue(context, "Object");
  const keysNameRegister = compileLiteralValue("keys", context);
  const keysFunctionRegister = newRegister(context);
  emit(context, [OpCode.GETFIELD, keysFunctionRegister, objectCtorRegister, keysNameRegister]);
  const keysArrayRegister = newRegister(context);
  emit(context, [OpCode.CALL, keysFunctionRegister, 1, keysArrayRegister, objectCtorRegister, "default", objectRegister]);

  const iteratorRegister = newRegister(context);
  const doneRegister = newRegister(context);
  const valueRegister = newRegister(context);
  const loopLabel = makeLabel(context, "FORIN");
  const endLabel = makeLabel(context, "ENDFORIN");

  emit(context, [OpCode.GETITER, iteratorRegister, keysArrayRegister]);
  pushControlLabel(context, { continueLabel: loopLabel, breakLabel: endLabel });
  emitLabel(context, loopLabel);
  emit(context, [OpCode.ITERNEXT, doneRegister, valueRegister, iteratorRegister]);
  emit(context, [OpCode.JUMPT, doneRegister, endLabel]);

  if (isWebCompatCallAssignmentTarget(node.left, context)) {
    await emitWebCompatCallAssignmentReferenceError(node.left, context);
  }

  pushScope(context);
  emit(context, [OpCode.PUSH_ENV]);
  if (node.left.type === "VariableDeclaration") {
    const declarator = node.left.declarations[0];
    initializeBinding(context, declarator.id.name, valueRegister, { declarationKind: node.left.kind });
  } else if (node.left.type === "Identifier") {
    storeBindingValue(context, node.left.name, valueRegister);
  } else if (isWebCompatCallAssignmentTarget(node.left, context)) {
    // Already evaluated above for web-compat side effects, then throws.
  } else {
    throw new Error(`Unsupported for-in left-hand side: ${node.left.type}`);
  }

  await compileStatement(node.body, context);
  emit(context, [OpCode.POP_ENV]);
  popScope(context);
  emit(context, [OpCode.JUMP, loopLabel]);
  emitLabel(context, endLabel);
  popControlLabel(context);
}

module.exports = compileForInStatement;

export {};
