// @ts-nocheck
const { OpCode } = require("../bytecode/opcodes");

function createBytecodeBuffer() {
  return {
    length: 0,
    array: [],
    push(line) {
      this.array.push(line);
      this.length += 1;
    },
    join(separator) {
      return this.array.map((line) => line.join(" ")).join(separator);
    },
  };
}

function createScope(parent = null) {
  return {
    parent,
    bindings: new Map(),
    nextSlot: 0,
  };
}

function createContext(options = {}) {
  const scopeStack = buildInitialScopeStack(options);
  return {
    options,
    bytecode: createBytecodeBuffer(),
    staticSection: options.staticSection || { values: [], indexByKey: new Map() },
    scopeStack,
    nextRegister: 0,
    labelCounter: 0,
    functionCounter: options.functionCounter || { value: 0 },
    functions: new Map(),
    controlLabels: [],
    withDepth: 0,
    strictMode: Boolean(options.strictMode),
  };
}

function createChildContext(parentContext, options = {}) {
  const scopeStack = parentContext.scopeStack.slice();
  scopeStack.push(createScope(scopeStack[scopeStack.length - 1] || null));
  return {
    options: parentContext.options,
    bytecode: createBytecodeBuffer(),
    staticSection: parentContext.staticSection,
    scopeStack,
    nextRegister: 0,
    labelCounter: 0,
    functionCounter: parentContext.functionCounter,
    functions: new Map(),
    controlLabels: [],
    withDepth: parentContext.withDepth || 0,
    strictMode: Boolean(parentContext.strictMode),
    functionName: options.functionName || null,
    expressionHandlers: parentContext.expressionHandlers,
    statementHandlers: parentContext.statementHandlers,
  };
}

function pushControlLabel(context, labelState) {
  context.controlLabels.push(labelState);
  return labelState;
}

function popControlLabel(context) {
  return context.controlLabels.pop();
}

function resolveBreakTarget(context, labelName = null) {
  for (let index = context.controlLabels.length - 1; index >= 0; index -= 1) {
    const state = context.controlLabels[index];
    if (labelName && state.label !== labelName) {
      continue;
    }
    if (!state.breakLabel) {
      continue;
    }
    return state.breakLabel;
  }
  return null;
}

function resolveContinueTarget(context, labelName = null) {
  for (let index = context.controlLabels.length - 1; index >= 0; index -= 1) {
    const state = context.controlLabels[index];
    if (labelName && state.label !== labelName) {
      continue;
    }
    if (!state.continueLabel) {
      continue;
    }
    return state.continueLabel;
  }
  return null;
}

function currentScope(context) {
  return context.scopeStack[context.scopeStack.length - 1];
}

function buildInitialScopeStack(options = {}) {
  if (Array.isArray(options.predeclaredScopeStack) && options.predeclaredScopeStack.length > 0) {
    return createScopeStackFromBindings(options.predeclaredScopeStack);
  }

  const rootScope = createScope(null);
  applyPredeclaredBindings(rootScope, options.predeclaredRootBindings);
  return [rootScope];
}

function createScopeStackFromBindings(bindingStack) {
  const scopes = [];
  const reversed = bindingStack.slice().reverse();
  let parent = null;

  for (const bindings of reversed) {
    const scope = createScope(parent);
    applyPredeclaredBindings(scope, bindings);
    scopes.push(scope);
    parent = scope;
  }

  return scopes.length > 0 ? scopes : [createScope(null)];
}

function applyPredeclaredBindings(scope, bindings = null) {
  if (!bindings) {
    return;
  }

  let nextSlot = scope.nextSlot;
  for (const [name, binding] of Object.entries(bindings)) {
    scope.bindings.set(name, { name, ...binding });
    nextSlot = Math.max(nextSlot, (binding.slot || 0) + 1);
  }
  scope.nextSlot = nextSlot;
}

function pushScope(context) {
  context.scopeStack.push(createScope(currentScope(context)));
}

function popScope(context) {
  context.scopeStack.pop();
}

function newRegister(context) {
  const register = `R${context.nextRegister}`;
  context.nextRegister += 1;
  return register;
}

function addStaticValue(context, value) {
  const key = getStaticValueKey(value);
  if (context.staticSection.indexByKey.has(key)) {
    return context.staticSection.indexByKey.get(key);
  }

  const index = context.staticSection.values.length;
  context.staticSection.values.push(value);
  context.staticSection.indexByKey.set(key, index);
  return index;
}

function getStaticValueKey(value) {
  if (value === null) {
    return "null";
  }

  const type = typeof value;
  switch (type) {
    case "bigint":
      return `bigint:${value.toString()}`;
    case "string":
      return `string:${value}`;
    case "number":
      if (Number.isNaN(value)) {
        return "number:NaN";
      }
      if (!Number.isFinite(value)) {
        return `number:${value > 0 ? "Infinity" : "-Infinity"}`;
      }
      if (Object.is(value, -0)) {
        return "number:-0";
      }
      return `number:${String(value)}`;
    case "boolean":
      return `boolean:${value ? 1 : 0}`;
    case "undefined":
      return "undefined";
    default:
      return `${type}:${String(value)}`;
  }
}

function emit(context, instruction) {
  context.bytecode.push(instruction);
}

function emitLabel(context, label) {
  emit(context, [`${label}:`]);
}

function makeLabel(context, prefix = "L") {
  context.labelCounter += 1;
  return `${prefix}${context.labelCounter}`;
}

function emitLoadConstant(context, destRegister, value) {
  const index = addStaticValue(context, value);
  emit(context, [OpCode.LOADK, destRegister, index]);
}

function declareBinding(context, name, meta = {}) {
  const scope = currentScope(context);
  if (scope.bindings.has(name)) {
    return scope.bindings.get(name);
  }

  const binding = {
    name,
    slot: scope.nextSlot,
    ...meta,
  };
  scope.nextSlot += 1;
  scope.bindings.set(name, binding);
  return binding;
}

function declareRootBinding(context, name, meta = {}) {
  const scope = context.scopeStack[0];
  if (scope.bindings.has(name)) {
    return {
      binding: scope.bindings.get(name),
      created: false,
    };
  }

  const binding = {
    name,
    slot: scope.nextSlot,
    ...meta,
  };
  scope.nextSlot += 1;
  scope.bindings.set(name, binding);
  return {
    binding,
    created: true,
  };
}

function resolveBinding(context, name) {
  for (let index = context.scopeStack.length - 1; index >= 0; index -= 1) {
    const scope = context.scopeStack[index];
    if (scope.bindings.has(name)) {
      return scope.bindings.get(name);
    }
  }
  return null;
}

function resolveBindingReference(context, name) {
  for (let index = context.scopeStack.length - 1; index >= 0; index -= 1) {
    const scope = context.scopeStack[index];
    if (scope.bindings.has(name)) {
      return {
        binding: scope.bindings.get(name),
        depth: context.scopeStack.length - 1 - index,
      };
    }
  }

  return null;
}

function resolveRootBindingReference(context, name) {
  const scope = context.scopeStack[0];
  if (!scope.bindings.has(name)) {
    return null;
  }

  return {
    binding: scope.bindings.get(name),
    depth: context.scopeStack.length - 1,
  };
}

function getRegister(context, name, meta = {}) {
  return declareBinding(context, name, meta).slot;
}

function resolveIdentifier(context, name) {
  if (name === "undefined") {
    const register = newRegister(context);
    emit(context, [OpCode.UNDEF, register]);
    return register;
  }

  const reference = resolveBindingReference(context, name);
  if (reference) {
    const register = newRegister(context);
    emit(context, [OpCode.LOADVAR, register, reference.depth, reference.binding.slot]);
    return register;
  }

  const register = newRegister(context);
  const staticIndex = addStaticValue(context, name);
  emit(context, [OpCode.GETENV, register, staticIndex]);
  return register;
}

function registerCompiledFunction(context, node, functionContext, functionName, params) {
  const functionId = `F${context.functionCounter.value}`;
  context.functionCounter.value += 1;
  context.functions.set(functionId, {
    id: functionId,
    name: functionName,
    params,
    paramBindings: params.map((name) => {
      const reference = resolveBindingReference(functionContext, name);
      return { depth: reference.depth, slot: reference.binding.slot };
    }),
    argumentsBinding: functionContext.argumentsBinding || null,
    restBinding: functionContext.restBinding || null,
    scopeBindings: serializeScopeBindings(functionContext.scopeStack[functionContext.scopeStack.length - 1]),
    thisMode: functionContext.thisMode || "dynamic",
    isAsync: Boolean(node.async),
    isGenerator: Boolean(node.generator),
    strictMode: Boolean(functionContext.strictMode),
    bytecode: functionContext.bytecode,
    functions: functionContext.functions,
    startLine: node.loc ? node.loc.start.line : null,
    endLine: node.loc ? node.loc.end.line : null,
  });
  return functionId;
}

function serializeScopeBindings(scope) {
  const entries = {};
  for (const [name, binding] of scope.bindings.entries()) {
    entries[name] = {
      slot: binding.slot,
      kind: binding.kind,
      declarationKind: binding.declarationKind,
      internal: Boolean(binding.internal),
    };
  }
  return entries;
}

function serializeFunctions(functions) {
  return Array.from(functions.values()).map((func) => ({
    id: func.id,
    name: func.name,
    params: func.params,
    paramBindings: func.paramBindings,
    argumentsBinding: func.argumentsBinding,
    restBinding: func.restBinding,
    scopeBindings: func.scopeBindings || {},
    thisMode: func.thisMode,
    isAsync: Boolean(func.isAsync),
    isGenerator: Boolean(func.isGenerator),
    strictMode: Boolean(func.strictMode),
    bytecode: func.bytecode.array.slice(),
    functions: serializeFunctions(func.functions || new Map()),
  }));
}

module.exports = {
  addStaticValue,
  createContext,
  createChildContext,
  createScope,
  currentScope,
  declareRootBinding,
  declareBinding,
  emit,
  emitLabel,
  emitLoadConstant,
  getRegister,
  makeLabel,
  newRegister,
  popControlLabel,
  pushControlLabel,
  resolveBreakTarget,
  resolveBindingReference,
  resolveContinueTarget,
  resolveRootBindingReference,
  popScope,
  pushScope,
  registerCompiledFunction,
  resolveBinding,
  resolveIdentifier,
  serializeScopeBindings,
  serializeFunctions,
};

export {};
