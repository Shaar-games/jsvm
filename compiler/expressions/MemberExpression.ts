// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, emitLoadConstant, newRegister } = require("../utils");

async function compileMemberExpression(node, context) {
  const objectRegister = await compileExpression(node.object, context);
  let propertyRegister;

  if (node.computed) {
    propertyRegister = await compileExpression(node.property, context);
  } else {
    propertyRegister = newRegister(context);
    emitLoadConstant(context, propertyRegister, node.property.name);
  }

  const resultRegister = newRegister(context);
  emit(context, [OpCode.GETFIELD, resultRegister, objectRegister, propertyRegister]);
  return resultRegister;
}

module.exports = compileMemberExpression;

export {};
