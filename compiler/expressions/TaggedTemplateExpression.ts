// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, compileLiteralValue, emit, emitLoadConstant, newRegister } = require("../utils");

async function compileTagCallee(tag, context) {
  if (tag.type === "MemberExpression") {
    const thisRegister = await compileExpression(tag.object, context);
    const propertyRegister = tag.computed
      ? await compileExpression(tag.property, context)
      : (() => {
          const register = newRegister(context);
          emitLoadConstant(context, register, tag.property.name);
          return register;
        })();
    const functionRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, functionRegister, thisRegister, propertyRegister]);
    return { functionRegister, thisRegister };
  }

  return {
    functionRegister: await compileExpression(tag, context),
    thisRegister: "null",
  };
}

async function compileTaggedTemplateExpression(node, context) {
  const { functionRegister, thisRegister } = await compileTagCallee(node.tag, context);
  const templateRegister = newRegister(context);
  const rawRegister = newRegister(context);
  emit(context, [OpCode.ARRAY, templateRegister]);
  emit(context, [OpCode.ARRAY, rawRegister]);

  for (const quasi of node.quasi.quasis) {
    const cookedRegister = compileLiteralValue(quasi.value.cooked, context);
    const rawValueRegister = compileLiteralValue(quasi.value.raw, context);
    emit(context, [OpCode.ARRAYPUSH, templateRegister, cookedRegister]);
    emit(context, [OpCode.ARRAYPUSH, rawRegister, rawValueRegister]);
  }

  const rawKeyRegister = compileLiteralValue("raw", context);
  emit(context, [OpCode.DEFINEFIELD, templateRegister, rawKeyRegister, rawRegister]);

  const argumentRegisters = [templateRegister];
  for (const expression of node.quasi.expressions) {
    argumentRegisters.push(await compileExpression(expression, context));
  }

  const returnRegister = newRegister(context);
  emit(context, [
    OpCode.CALL,
    functionRegister,
    argumentRegisters.length,
    returnRegister,
    thisRegister,
    "default",
    ...argumentRegisters,
  ]);
  return returnRegister;
}

module.exports = compileTaggedTemplateExpression;

export {};
