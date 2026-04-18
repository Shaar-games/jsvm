// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { assignPattern } = require("../patterns");
const { getAssignmentBinaryOpcodeName } = require("../operators");
const {
  OpCode,
  emit,
  compileLiteralValue,
  loadBindingValue,
  newRegister,
  storeBindingValue,
} = require("../utils");

async function compileAssignmentExpression(node, context) {
  if (node.left.type === "Identifier") {
    if (node.operator !== "=") {
      const opcodeName = getAssignmentBinaryOpcodeName(node.operator);
      if (!opcodeName) {
        throw new Error(`Unsupported assignment operator: ${node.operator}`);
      }
      const currentValueRegister = loadBindingValue(context, node.left.name);
      const rightValueRegister = await compileExpression(node.right, context);
      const resultRegister = newRegister(context);
      emit(context, [OpCode[opcodeName], resultRegister, currentValueRegister, rightValueRegister]);
      storeBindingValue(context, node.left.name, resultRegister);
      return resultRegister;
    }

    const valueRegister = await compileExpression(node.right, context);
    storeBindingValue(context, node.left.name, valueRegister);
    return valueRegister;
  }

  if (node.left.type === "MemberExpression") {
    const objectRegister = await compileExpression(node.left.object, context);
    const propertyRegister = node.left.computed
      ? await compileExpression(node.left.property, context)
      : compileLiteralValue(node.left.property.name, context);

    if (node.operator !== "=") {
      const opcodeName = getAssignmentBinaryOpcodeName(node.operator);
      if (!opcodeName) {
        throw new Error(`Unsupported assignment operator: ${node.operator}`);
      }
      const currentValueRegister = newRegister(context);
      emit(context, [OpCode.GETFIELD, currentValueRegister, objectRegister, propertyRegister]);
      const rightValueRegister = await compileExpression(node.right, context);
      const resultRegister = newRegister(context);
      emit(context, [OpCode[opcodeName], resultRegister, currentValueRegister, rightValueRegister]);
      emit(context, [OpCode.SETFIELD, objectRegister, propertyRegister, resultRegister]);
      return resultRegister;
    }

    const valueRegister = await compileExpression(node.right, context);
    emit(context, [OpCode.SETFIELD, objectRegister, propertyRegister, valueRegister]);
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
