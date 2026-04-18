// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, newRegister } = require("../utils");

async function compileNewExpression(node, context) {
  const ctorRegister = await compileExpression(node.callee, context);
  const hasSpread = node.arguments.some((argument) => argument.type === "SpreadElement");

  if (!hasSpread) {
    const argumentRegisters = [];
    for (const argument of node.arguments) {
      argumentRegisters.push(await compileExpression(argument, context));
    }

    const resultRegister = newRegister(context);
    emit(context, [OpCode.NEW, resultRegister, ctorRegister, argumentRegisters.length, ...argumentRegisters]);
    return resultRegister;
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

  const resultRegister = newRegister(context);
  emit(context, [OpCode.NEWSPREAD, resultRegister, ctorRegister, argsArrayRegister]);
  return resultRegister;
}

module.exports = compileNewExpression;

export {};
