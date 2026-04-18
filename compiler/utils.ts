// @ts-nocheck
const { OpCode } = require("../bytecode/opcodes");
const {
  addStaticValue,
  createChildContext,
  declareBinding,
  emit,
  emitLabel,
  emitLoadConstant,
  getRegister,
  makeLabel,
  newRegister,
  registerCompiledFunction,
  resolveBindingReference,
  resolveIdentifier,
} = require("./context");

function compileLiteralValue(value, context) {
  const register = newRegister(context);
  if (value === undefined) {
    emit(context, [OpCode.UNDEF, register]);
    return register;
  }
  if (value === null) {
    emit(context, [OpCode.NULL, register]);
    return register;
  }
  if (typeof value === "boolean") {
    emit(context, [OpCode.BOOL, register, value ? 1 : 0]);
    return register;
  }
  emitLoadConstant(context, register, value);
  return register;
}

async function compileFunctionLike(node, context, functionName, bodyHandler) {
  const functionContext = createChildContext(context, { functionName });
  functionContext.thisMode = node.type === "ArrowFunctionExpression" ? "lexical" : "dynamic";
  const params = [];
  const paramSetup = [];

  for (let index = 0; index < node.params.length; index += 1) {
    const param = node.params[index];
    if (param.type === "Identifier") {
      params.push(param.name);
      declareBinding(functionContext, param.name, {
        kind: "param",
        declarationKind: "param",
      });
      continue;
    }

    if (param.type === "AssignmentPattern" && param.left.type === "Identifier") {
      params.push(param.left.name);
      declareBinding(functionContext, param.left.name, {
        kind: "param",
        declarationKind: "param",
      });
      paramSetup.push({ type: "default", param });
      continue;
    }

    if (param.type === "RestElement" && param.argument.type === "Identifier") {
      params.push(param.argument.name);
      const binding = declareBinding(functionContext, param.argument.name, {
        kind: "param",
        declarationKind: "param",
      });
      functionContext.restBinding = {
        name: param.argument.name,
        slot: binding.slot,
        depth: 0,
        index,
      };
      continue;
    }

    throw new Error(`Unsupported parameter type: ${param.type}`);
  }

  const functionId = registerCompiledFunction(
    context,
    node,
    functionContext,
    functionName,
    params
  );

  for (const setup of paramSetup) {
    const reference = resolveBindingReference(functionContext, setup.param.left.name);
    const currentValue = newRegister(functionContext);
    emit(functionContext, [OpCode.LOADVAR, currentValue, reference.depth, reference.binding.slot]);
    const undefinedRegister = compileLiteralValue(undefined, functionContext);
    const testRegister = newRegister(functionContext);
    const useDefaultLabel = makeLabel(functionContext, "PARAM_DEFAULT");
    const doneLabel = makeLabel(functionContext, "PARAM_DONE");
    emit(functionContext, [OpCode.ISEQ, testRegister, currentValue, undefinedRegister]);
    emit(functionContext, [OpCode.JUMPT, testRegister, useDefaultLabel]);
    emit(functionContext, [OpCode.JUMP, doneLabel]);
    emitLabel(functionContext, useDefaultLabel);
    const defaultRegister = await compileExpressionInContext(setup.param.right, functionContext);
    emit(functionContext, [OpCode.STOREVAR, reference.depth, reference.binding.slot, defaultRegister]);
    emitLabel(functionContext, doneLabel);
  }

  await bodyHandler(functionContext);

  const targetRegister = newRegister(context);
  emit(context, [OpCode.CLOSURE, targetRegister, functionId]);
  return targetRegister;
}

async function compileExpressionInContext(node, context) {
  const { compileExpression } = require("./dispatch/expressions");
  return compileExpression(node, context);
}

function declareLexicalBinding(context, name, meta = {}) {
  return declareBinding(context, name, meta);
}

function loadBindingValue(context, name) {
  if (name === "undefined") {
    return compileLiteralValue(undefined, context);
  }

  const reference = resolveBindingReference(context, name);
  if (!reference) {
    const register = newRegister(context);
    const staticIndex = addStaticValue(context, name);
    emit(context, [OpCode.GETENV, register, staticIndex]);
    return register;
  }

  const register = newRegister(context);
  emit(context, [OpCode.LOADVAR, register, reference.depth, reference.binding.slot]);
  return register;
}

function storeBindingValue(context, name, valueRegister) {
  const reference = resolveBindingReference(context, name);
  if (!reference) {
    const staticIndex = addStaticValue(context, name);
    emit(context, [OpCode.SETENV, staticIndex, valueRegister]);
    return valueRegister;
  }

  emit(context, [OpCode.STOREVAR, reference.depth, reference.binding.slot, valueRegister]);
  return valueRegister;
}

function initializeBinding(context, name, valueRegister, meta = {}) {
  const binding = declareBinding(context, name, meta);
  emit(context, [OpCode.INITVAR, 0, binding.slot, valueRegister]);
  return binding;
}

module.exports = {
  OpCode,
  addStaticValue,
  compileFunctionLike,
  compileLiteralValue,
  declareLexicalBinding,
  emit,
  emitLabel,
  emitLoadConstant,
  getRegister,
  initializeBinding,
  loadBindingValue,
  makeLabel,
  newRegister,
  resolveIdentifier,
  storeBindingValue,
};

export {};
