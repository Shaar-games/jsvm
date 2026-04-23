// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, emitLoadConstant, newRegister } = require("../utils");

async function compileMemberExpression(node, context) {
  if (node.object.type === "Super") {
    const propertyRegister = node.computed
      ? await compileExpression(node.property, context)
      : (() => {
          const register = newRegister(context);
          emitLoadConstant(context, register, node.property.name);
          return register;
        })();
    const resultRegister = newRegister(context);
    emit(context, [OpCode.SUPER_GET, resultRegister, propertyRegister]);
    return resultRegister;
  }

  const objectRegister = await compileExpression(node.object, context);
  let propertyRegister;

  if (node.computed) {
    propertyRegister = await compileExpression(node.property, context);
  } else {
    propertyRegister = newRegister(context);
    emitLoadConstant(context, propertyRegister, node.property.name);
  }

  const resultRegister = newRegister(context);
  if (node.optional) {
    const nullRegister = newRegister(context);
    const undefinedRegister = newRegister(context);
    const isNullRegister = newRegister(context);
    const isUndefinedRegister = newRegister(context);
    const readLabel = `L${context.labelCounter + 1}`;
    const doneLabel = `L${context.labelCounter + 2}`;
    context.labelCounter += 2;
    emit(context, [OpCode.NULL, nullRegister]);
    emit(context, [OpCode.UNDEF, undefinedRegister]);
    emit(context, [OpCode.ISEQ, isNullRegister, objectRegister, nullRegister]);
    emit(context, [OpCode.ISEQ, isUndefinedRegister, objectRegister, undefinedRegister]);
    emit(context, [OpCode.JUMPF, isNullRegister, readLabel]);
    emit(context, [OpCode.MOVE, resultRegister, undefinedRegister]);
    emit(context, [OpCode.JUMP, doneLabel]);
    emit(context, [`${readLabel}:`]);
    emit(context, [OpCode.JUMPF, isUndefinedRegister, `${readLabel}_READ`]);
    emit(context, [OpCode.MOVE, resultRegister, undefinedRegister]);
    emit(context, [OpCode.JUMP, doneLabel]);
    emit(context, [`${readLabel}_READ:`]);
    emit(context, [OpCode.GETFIELD, resultRegister, objectRegister, propertyRegister]);
    emit(context, [`${doneLabel}:`]);
    return resultRegister;
  }
  emit(context, [OpCode.GETFIELD, resultRegister, objectRegister, propertyRegister]);
  return resultRegister;
}

module.exports = compileMemberExpression;

export {};
