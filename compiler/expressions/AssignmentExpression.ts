// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const {
  compileAssignmentTarget,
  emitLoadAssignmentTarget,
  emitStoreAssignmentTarget,
} = require("../assignment-targets");
const { assignPattern } = require("../patterns");
const { getAssignmentBinaryOpcodeName } = require("../operators");
const {
  emitWebCompatCallAssignmentReferenceError,
  isWebCompatCallAssignmentTarget,
} = require("../web-compat-targets");
const {
  OpCode,
  emit,
  compileLiteralValue,
  emitLabel,
  makeLabel,
  newRegister,
} = require("../utils");

async function compileAssignmentExpression(node, context) {
  if (isWebCompatCallAssignmentTarget(node.left, context)) {
    await emitWebCompatCallAssignmentReferenceError(node.left, context);
    return newRegister(context);
  }

  if (node.left.type === "Identifier" || node.left.type === "MemberExpression") {
    const target = await compileAssignmentTarget(node.left, context);

    if (node.operator === "&&=" || node.operator === "||=" || node.operator === "??=") {
      const currentValueRegister = emitLoadAssignmentTarget(target, context);
      const resultRegister = newRegister(context);
      const endLabel = makeLabel(context, "LOGICAL_ASSIGN_END");

      emit(context, [OpCode.MOVE, resultRegister, currentValueRegister]);
      if (node.operator === "&&=") {
        emit(context, [OpCode.JUMPF, currentValueRegister, endLabel]);
      } else if (node.operator === "||=") {
        emit(context, [OpCode.JUMPT, currentValueRegister, endLabel]);
      } else {
        const nullRegister = compileLiteralValue(null, context);
        const undefinedRegister = compileLiteralValue(undefined, context);
        const isNullRegister = newRegister(context);
        const isUndefinedRegister = newRegister(context);
        const assignLabel = makeLabel(context, "LOGICAL_ASSIGN_NULLISH");
        emit(context, [OpCode.ISEQ, isNullRegister, currentValueRegister, nullRegister]);
        emit(context, [OpCode.ISEQ, isUndefinedRegister, currentValueRegister, undefinedRegister]);
        emit(context, [OpCode.JUMPT, isNullRegister, assignLabel]);
        emit(context, [OpCode.JUMPT, isUndefinedRegister, assignLabel]);
        emit(context, [OpCode.JUMP, endLabel]);
        emitLabel(context, assignLabel);
      }

      const rightValueRegister = await compileExpression(node.right, context);
      emit(context, [OpCode.MOVE, resultRegister, rightValueRegister]);
      emitStoreAssignmentTarget(target, rightValueRegister, context);
      emitLabel(context, endLabel);
      return resultRegister;
    }

    if (node.operator !== "=") {
      const opcodeName = getAssignmentBinaryOpcodeName(node.operator);
      if (!opcodeName) {
        throw new Error(`Unsupported assignment operator: ${node.operator}`);
      }
      const currentValueRegister = emitLoadAssignmentTarget(target, context);
      const rightValueRegister = await compileExpression(node.right, context);
      const resultRegister = newRegister(context);
      emit(context, [OpCode[opcodeName], resultRegister, currentValueRegister, rightValueRegister]);
      emitStoreAssignmentTarget(target, resultRegister, context);
      return resultRegister;
    }

    const valueRegister = await compileExpression(node.right, context);
    emitStoreAssignmentTarget(target, valueRegister, context);
    return valueRegister;
  }

  if (node.left.type === "ArrayPattern") {
    const sourceRegister = await compileExpression(node.right, context);
    await assignPattern(node.left, context, sourceRegister);
    return sourceRegister;
  }

  if (node.left.type === "ObjectPattern") {
    const sourceRegister = await compileExpression(node.right, context);
    await assignPattern(node.left, context, sourceRegister);
    return sourceRegister;
  }

  throw new Error(`Unsupported left-hand side in assignment: ${node.left.type}`);
}

module.exports = compileAssignmentExpression;

export {};
