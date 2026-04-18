// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, compileLiteralValue, newRegister } = require("../utils");

async function compileArrayExpression(node, context) {
  const arrayRegister = newRegister(context);
  emit(context, [OpCode.ARRAY, arrayRegister]);

  for (let index = 0; index < node.elements.length; index += 1) {
    const element = node.elements[index];
    if (!element) {
      continue;
    }

    if (element.type === "SpreadElement") {
      const spreadRegister = await compileExpression(element.argument, context);
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
      emit(context, [OpCode.ARRAYPUSH, arrayRegister, valueRegister]);
      emit(context, [OpCode.JUMP, loopLabel]);
      emit(context, [`${endLabel}:`]);
      continue;
    }

    const valueRegister = await compileExpression(element, context);
    emit(context, [OpCode.ARRAYPUSH, arrayRegister, valueRegister]);
  }

  return arrayRegister;
}

module.exports = compileArrayExpression;

export {};
