// @ts-nocheck
const { compileExpression } = require("./dispatch/expressions");
const { OpCode, compileLiteralValue, emit, newRegister, loadBindingValue, storeBindingValue } = require("./utils");

async function compileAssignmentTarget(node, context) {
  if (node.type === "Identifier") {
    return {
      type: "binding",
      name: node.name,
    };
  }

  if (node.type === "MemberExpression") {
    const objectRegister = await compileExpression(node.object, context);
    const propertyRegister = node.computed
      ? await compileExpression(node.property, context)
      : compileLiteralValue(node.property.name, context);

    return {
      type: "member",
      objectRegister,
      propertyRegister,
    };
  }

  throw new Error(`Unsupported left-hand side in assignment: ${node.type}`);
}

function emitLoadAssignmentTarget(target, context) {
  if (target.type === "binding") {
    return loadBindingValue(context, target.name);
  }

  const currentValueRegister = newRegister(context);
  emit(context, [OpCode.GETFIELD, currentValueRegister, target.objectRegister, target.propertyRegister]);
  return currentValueRegister;
}

function emitStoreAssignmentTarget(target, valueRegister, context) {
  if (target.type === "binding") {
    storeBindingValue(context, target.name, valueRegister);
    return;
  }

  emit(context, [OpCode.SETFIELD, target.objectRegister, target.propertyRegister, valueRegister]);
}

module.exports = {
  compileAssignmentTarget,
  emitLoadAssignmentTarget,
  emitStoreAssignmentTarget,
};

export {};
