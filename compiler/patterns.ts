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
const { collectPatternBindingNames } = require("./pattern-bindings");

async function assignPatternNode(patternNode, context, sourceRegister, handlers) {
  if (!patternNode) {
    return;
  }

  if (patternNode.type === "Identifier") {
    handlers.assignIdentifier(patternNode.name, sourceRegister);
    return;
  }

  if (patternNode.type === "MemberExpression") {
    if (typeof handlers.assignMemberExpression !== "function") {
      throw new Error(`Unsupported pattern element: ${patternNode.type}`);
    }
    await handlers.assignMemberExpression(patternNode, sourceRegister);
    return;
  }

  if (patternNode.type === "AssignmentPattern") {
    const undefinedRegister = compileLiteralValue(undefined, context);
    const testRegister = newRegister(context);
    const resolvedRegister = newRegister(context);
    const useDefaultLabel = `L${context.labelCounter + 1}`;
    const doneLabel = `L${context.labelCounter + 2}`;
    context.labelCounter += 2;

    emit(context, [OpCode.ISEQ, testRegister, sourceRegister, undefinedRegister]);
    emit(context, [OpCode.JUMPT, testRegister, useDefaultLabel]);
    emit(context, [OpCode.MOVE, resolvedRegister, sourceRegister]);
    emit(context, [OpCode.JUMP, doneLabel]);
    emit(context, [`${useDefaultLabel}:`]);
    const defaultRegister = await compileExpression(patternNode.right, context);
    emit(context, [OpCode.MOVE, resolvedRegister, defaultRegister]);
    emit(context, [`${doneLabel}:`]);
    await assignPatternNode(patternNode.left, context, resolvedRegister, handlers);
    return;
  }

  if (patternNode.type === "ObjectPattern") {
    await assignObjectPattern(patternNode, context, sourceRegister, handlers);
    return;
  }

  if (patternNode.type === "ArrayPattern") {
    await assignArrayPattern(patternNode, context, sourceRegister, handlers);
    return;
  }

  if (patternNode.type === "RestElement") {
    await assignPatternNode(patternNode.argument, context, sourceRegister, handlers);
    return;
  }

  throw new Error(`Unsupported pattern element: ${patternNode.type}`);
}

async function assignObjectPattern(patternNode, context, sourceRegister, handlers) {
  for (const property of patternNode.properties) {
    if (property.type === "RestElement") {
      throw new Error("Unsupported object rest destructuring");
    }

    const keyRegister = compileLiteralValue(property.key.name ?? property.key.value, context);
    const valueRegister = newRegister(context);
    emit(context, [OpCode.GETFIELD, valueRegister, sourceRegister, keyRegister]);
    await assignPatternNode(property.value, context, valueRegister, handlers);
  }
}

async function assignArrayPattern(patternNode, context, sourceRegister, handlers) {
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
    await assignPatternNode(element, context, valueRegister, handlers);
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
    await assignPatternNode(restElement.argument, context, restArray, handlers);
  }
}

async function initializePattern(patternNode, context, sourceRegister, declarationKind) {
  return assignPatternNode(patternNode, context, sourceRegister, {
    assignIdentifier: (name, valueRegister) =>
      initializeBinding(context, name, valueRegister, { declarationKind }),
  });
}

async function assignPattern(patternNode, context, sourceRegister) {
  const { compileAssignmentTarget, emitStoreAssignmentTarget } = require("./assignment-targets");
  return assignPatternNode(patternNode, context, sourceRegister, {
    assignIdentifier: (name, valueRegister) => storeBindingValue(context, name, valueRegister),
    assignMemberExpression: async (node, valueRegister) => {
      const target = await compileAssignmentTarget(node, context);
      emitStoreAssignmentTarget(target, valueRegister, context);
    },
  });
}

module.exports = {
  assignPattern,
  collectPatternBindingNames,
  initializePattern,
};

export {};
