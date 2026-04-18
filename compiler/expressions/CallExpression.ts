// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, emitLoadConstant, newRegister, loadBindingValue } = require("../utils");

async function compileCallExpression(node, context) {
  let functionRegister;
  let thisRegister = null;
  let callMode = "default";

  if (node.callee.type === "MemberExpression") {
    thisRegister = await compileExpression(node.callee.object, context);
    let propertyRegister;
    if (node.callee.computed) {
      propertyRegister = await compileExpression(node.callee.property, context);
    } else {
      propertyRegister = newRegister(context);
      emitLoadConstant(context, propertyRegister, node.callee.property.name);
    }
    functionRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, functionRegister, thisRegister, propertyRegister]);
  } else if (node.callee.type === "Identifier") {
    functionRegister = loadBindingValue(context, node.callee.name);
    if (node.callee.name === "eval") {
      callMode = "direct-eval";
    }
  } else {
    functionRegister = await compileExpression(node.callee, context);
  }

  const hasSpread = node.arguments.some((argument) => argument.type === "SpreadElement");
  if (!hasSpread) {
    const argumentRegisters = [];
    for (const argument of node.arguments) {
      argumentRegisters.push(await compileExpression(argument, context));
    }

    const returnRegister = newRegister(context);
    emit(context, [
      OpCode.CALL,
      functionRegister,
      argumentRegisters.length,
      returnRegister,
      thisRegister || "null",
      callMode,
      ...argumentRegisters,
    ]);
    return returnRegister;
  }

  const argsArrayRegister = newRegister(context);
  emit(context, [OpCode.ARRAY, argsArrayRegister]);
  for (const argument of node.arguments) {
    if (argument.type === "SpreadElement") {
      const spreadRegister = await compileExpression(argument.argument, context);
      const iteratorRegister = newRegister(context);
      const doneRegister = newRegister(context);
      const valueRegister = newRegister(context);
      const loopLabel = `L${context.labelCounter + 1}`;
      const endLabel = `L${context.labelCounter + 2}`;
      context.labelCounter += 2;
      emit(context, [OpCode.GETITER, iteratorRegister, spreadRegister]);
      emit(context, [`${loopLabel}:`]);
      emit(context, [OpCode.ITERNEXT, doneRegister, valueRegister, iteratorRegister]);
      emit(context, [OpCode.JUMPT, doneRegister, endLabel]);
      emit(context, [OpCode.ARRAYPUSH, argsArrayRegister, valueRegister]);
      emit(context, [OpCode.JUMP, loopLabel]);
      emit(context, [`${endLabel}:`]);
      continue;
    }

    const argumentRegister = await compileExpression(argument, context);
    emit(context, [OpCode.ARRAYPUSH, argsArrayRegister, argumentRegister]);
  }

  const returnRegister = newRegister(context);
  emit(context, [OpCode.CALLSPREAD, functionRegister, argsArrayRegister, returnRegister, thisRegister || "null", callMode]);
  return returnRegister;
}

module.exports = compileCallExpression;

export {};
