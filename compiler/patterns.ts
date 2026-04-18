// @ts-nocheck
const { compileExpression } = require("./dispatch/expressions");
const {
  OpCode,
  emit,
  compileLiteralValue,
  newRegister,
  initializeBinding,
  storeBindingValue,
} = require("./utils");

async function assignObjectPattern(patternNode, context, sourceRegister, assignValue) {
  for (const property of patternNode.properties) {
    if (property.type === "RestElement") {
      throw new Error("Unsupported object rest destructuring");
    }

    const keyRegister = compileLiteralValue(property.key.name ?? property.key.value, context);
    const valueRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, valueRegister, sourceRegister, keyRegister]);

    if (property.value.type === "Identifier") {
      assignValue(property.value.name, valueRegister);
      continue;
    }

    if (property.value.type === "AssignmentPattern" && property.value.left.type === "Identifier") {
      const undefinedRegister = compileLiteralValue(undefined, context);
      const defaultRegister = await compileExpression(property.value.right, context);
      const testRegister = newRegister(context);
      const useDefaultLabel = `L${context.labelCounter + 1}`;
      const doneLabel = `L${context.labelCounter + 2}`;
      context.labelCounter += 2;
      emit(context, [OpCode.ISEQ, testRegister, valueRegister, undefinedRegister]);
      emit(context, [OpCode.JUMPT, testRegister, useDefaultLabel]);
      assignValue(property.value.left.name, valueRegister);
      emit(context, [OpCode.JUMP, doneLabel]);
      emit(context, [`${useDefaultLabel}:`]);
      assignValue(property.value.left.name, defaultRegister);
      emit(context, [`${doneLabel}:`]);
      continue;
    }

    throw new Error(`Unsupported pattern element: ${property.value.type}`);
  }
}

async function assignArrayPattern(patternNode, context, sourceRegister, assignValue, initializeValue) {
  let restIndex = -1;
  for (let index = 0; index < patternNode.elements.length; index += 1) {
    const element = patternNode.elements[index];
    if (element && element.type === "RestElement") {
      restIndex = index;
      break;
    }
  }

  const stopIndex = restIndex === -1 ? patternNode.elements.length : restIndex;
  for (let index = 0; index < stopIndex; index += 1) {
    const element = patternNode.elements[index];
    if (!element) {
      continue;
    }

    const indexRegister = compileLiteralValue(index, context);
    const valueRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, valueRegister, sourceRegister, indexRegister]);

    if (element.type === "Identifier") {
      assignValue(element.name, valueRegister);
      continue;
    }

    if (element.type === "AssignmentPattern" && element.left.type === "Identifier") {
      const undefinedRegister = compileLiteralValue(undefined, context);
      const defaultRegister = await compileExpression(element.right, context);
      const testRegister = newRegister(context);
      const useDefaultLabel = `L${context.labelCounter + 1}`;
      const doneLabel = `L${context.labelCounter + 2}`;
      context.labelCounter += 2;
      emit(context, [OpCode.ISEQ, testRegister, valueRegister, undefinedRegister]);
      emit(context, [OpCode.JUMPT, testRegister, useDefaultLabel]);
      assignValue(element.left.name, valueRegister);
      emit(context, [OpCode.JUMP, doneLabel]);
      emit(context, [`${useDefaultLabel}:`]);
      assignValue(element.left.name, defaultRegister);
      emit(context, [`${doneLabel}:`]);
      continue;
    }

    throw new Error(`Unsupported pattern element in array: ${element.type}`);
  }

  if (restIndex !== -1) {
    const restElement = patternNode.elements[restIndex];
    const restArray = newRegister(context);
    emit(context, [OpCode.ARRAY, restArray]);
    const lengthProperty = compileLiteralValue("length", context);
    const lengthRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, lengthRegister, sourceRegister, lengthProperty]);
    const cursorRegister = compileLiteralValue(restIndex, context);
    const loopLabel = `L${context.labelCounter + 1}`;
    const endLabel = `L${context.labelCounter + 2}`;
    context.labelCounter += 2;

    emit(context, [`${loopLabel}:`]);
    const doneRegister = newRegister(context);
    emit(context, [OpCode.ISGE, doneRegister, cursorRegister, lengthRegister]);
    emit(context, [OpCode.JUMPT, doneRegister, endLabel]);
    const valueRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, valueRegister, sourceRegister, cursorRegister]);
    emit(context, [OpCode.ARRAYPUSH, restArray, valueRegister]);
    const oneRegister = compileLiteralValue(1, context);
    emit(context, [OpCode.ADD, cursorRegister, cursorRegister, oneRegister]);
    emit(context, [OpCode.JUMP, loopLabel]);
    emit(context, [`${endLabel}:`]);

    if (initializeValue) {
      initializeValue(restElement.argument.name, restArray);
    } else {
      assignValue(restElement.argument.name, restArray);
    }
  }
}

async function initializePattern(patternNode, context, sourceRegister, declarationKind) {
  if (patternNode.type === "ObjectPattern") {
    return assignObjectPattern(patternNode, context, sourceRegister, (name, valueRegister) =>
      initializeBinding(context, name, valueRegister, { declarationKind })
    );
  }

  if (patternNode.type === "ArrayPattern") {
    return assignArrayPattern(
      patternNode,
      context,
      sourceRegister,
      (name, valueRegister) => initializeBinding(context, name, valueRegister, { declarationKind }),
      (name, valueRegister) => initializeBinding(context, name, valueRegister, { declarationKind })
    );
  }

  throw new Error(`Unsupported declaration type: ${patternNode.type}`);
}

async function assignPattern(patternNode, context, sourceRegister) {
  if (patternNode.type === "ObjectPattern") {
    return assignObjectPattern(patternNode, context, sourceRegister, (name, valueRegister) =>
      storeBindingValue(context, name, valueRegister)
    );
  }

  if (patternNode.type === "ArrayPattern") {
    return assignArrayPattern(
      patternNode,
      context,
      sourceRegister,
      (name, valueRegister) => storeBindingValue(context, name, valueRegister)
    );
  }

  throw new Error(`Unsupported assignment pattern: ${patternNode.type}`);
}

module.exports = {
  assignPattern,
  initializePattern,
};

export {};
