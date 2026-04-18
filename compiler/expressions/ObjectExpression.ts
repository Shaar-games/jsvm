// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, emitLoadConstant, newRegister } = require("../utils");

async function compileObjectExpression(node, context) {
  const objectRegister = newRegister(context);
  emit(context, [OpCode.OBJECT, objectRegister]);

  for (const property of node.properties) {
    if (property.type !== "Property") {
      throw new Error(`Unsupported object property type: ${property.type}`);
    }

    const valueRegister = await compileExpression(property.value, context);
    let keyRegister;
    if (property.computed) {
      keyRegister = await compileExpression(property.key, context);
    } else {
      keyRegister = newRegister(context);
      emitLoadConstant(context, keyRegister, property.key.name || property.key.value);
    }

    emit(context, [OpCode.SETFIELD, objectRegister, keyRegister, valueRegister]);
  }

  return objectRegister;
}

module.exports = compileObjectExpression;

export {};
