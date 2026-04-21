// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { pushScope, popScope } = require("../context");
const { initializePattern } = require("../patterns");
const { OpCode, emit, emitLabel, initializeBinding, makeLabel, newRegister, popControlLabel, pushControlLabel, storeBindingValue } = require("../utils");
const {
  emitWebCompatCallAssignmentReferenceError,
  isWebCompatCallAssignmentTarget,
} = require("../web-compat-targets");

async function compileForOfStatement(node, context) {
  const iterableRegister = await compileExpression(node.right, context);
  const iteratorRegister = newRegister(context);
  const doneRegister = newRegister(context);
  const valueRegister = newRegister(context);
  const loopLabel = makeLabel(context, "FOROF");
  const endLabel = makeLabel(context, "ENDFOROF");

  emit(context, [OpCode.GETITER, iteratorRegister, iterableRegister]);
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
    if (declarator.id.type === "Identifier") {
      initializeBinding(context, declarator.id.name, valueRegister, { declarationKind: node.left.kind });
    } else {
      await initializePattern(declarator.id, context, valueRegister, node.left.kind);
    }
  } else if (node.left.type === "Identifier") {
    storeBindingValue(context, node.left.name, valueRegister);
  } else if (isWebCompatCallAssignmentTarget(node.left, context)) {
    // Already evaluated above for web-compat side effects, then throws.
  } else {
    throw new Error(`Unsupported for-of left-hand side: ${node.left.type}`);
  }

  await compileStatement(node.body, context);
  emit(context, [OpCode.POP_ENV]);
  popScope(context);
  emit(context, [OpCode.JUMP, loopLabel]);
  emitLabel(context, endLabel);
  popControlLabel(context);
}

module.exports = compileForOfStatement;

export {};
