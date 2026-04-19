// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { addStaticValue } = require("../context");
const { OpCode, emit, emitLoadConstant, newRegister } = require("../utils");

function emitObjectLiteralKey(property, context) {
  if (property.computed) {
    return compileExpression(property.key, context);
  }

  const keyRegister = newRegister(context);
  emitLoadConstant(context, keyRegister, property.key.name || property.key.value);
  return keyRegister;
}

async function emitAccessorProperty(objectRegister, property, context) {
  const descriptorRegister = newRegister(context);
  emit(context, [OpCode.OBJECT, descriptorRegister]);

  const accessorRegister = await compileExpression(property.value, context);
  const kindKeyRegister = newRegister(context);
  emitLoadConstant(context, kindKeyRegister, property.kind);
  emit(context, [OpCode.SETFIELD, descriptorRegister, kindKeyRegister, accessorRegister]);

  const enumerableKeyRegister = newRegister(context);
  emitLoadConstant(context, enumerableKeyRegister, "enumerable");
  const enumerableValueRegister = newRegister(context);
  emit(context, [OpCode.BOOL, enumerableValueRegister, property.enumerable ? 1 : 0]);
  emit(context, [OpCode.SETFIELD, descriptorRegister, enumerableKeyRegister, enumerableValueRegister]);

  const configurableKeyRegister = newRegister(context);
  emitLoadConstant(context, configurableKeyRegister, "configurable");
  const configurableValueRegister = newRegister(context);
  emit(context, [OpCode.BOOL, configurableValueRegister, 1]);
  emit(context, [OpCode.SETFIELD, descriptorRegister, configurableKeyRegister, configurableValueRegister]);

  const definePropertyKeyRegister = newRegister(context);
  emitLoadConstant(context, definePropertyKeyRegister, "defineProperty");
  const objectValueRegister = newRegister(context);
  emit(context, [OpCode.GETENV, objectValueRegister, addStaticValue(context, "Object")]);
  const definePropertyRegister = newRegister(context);
  emit(context, [OpCode.GETFIELD, definePropertyRegister, objectValueRegister, definePropertyKeyRegister]);

  const targetKeyRegister = await emitObjectLiteralKey(property, context);
  const resultRegister = newRegister(context);
  emit(
    context,
    [OpCode.CALL, definePropertyRegister, 3, resultRegister, objectValueRegister, "default", objectRegister, targetKeyRegister, descriptorRegister]
  );
}

async function compileObjectExpression(node, context) {
  const objectRegister = newRegister(context);
  emit(context, [OpCode.OBJECT, objectRegister]);

  for (const property of node.properties) {
    if (property.type !== "Property") {
      throw new Error(`Unsupported object property type: ${property.type}`);
    }

    if (property.kind === "get" || property.kind === "set") {
      await emitAccessorProperty(objectRegister, property, context);
      continue;
    }

    const valueRegister = await compileExpression(property.value, context);
    const keyRegister = await emitObjectLiteralKey(property, context);
    emit(context, [OpCode.SETFIELD, objectRegister, keyRegister, valueRegister]);
  }

  return objectRegister;
}

module.exports = compileObjectExpression;

export {};
