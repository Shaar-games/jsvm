// @ts-nocheck
const { declareRootBinding, resolveRootBindingReference } = require("./context");
const { OpCode, compileLiteralValue, emit } = require("./utils");

async function withAnnexBBlockFunctionContext(context, callback) {
  if (context.options.sourceType !== "script") {
    return callback();
  }

  const previous = context.annexBBlockFunctionContext;
  context.annexBBlockFunctionContext = true;
  try {
    return await callback();
  } finally {
    context.annexBBlockFunctionContext = previous;
  }
}

function collectAnnexBBlockFunctionNames(node, names = new Set(), insideContainer = false) {
  if (!node || typeof node !== "object") {
    return names;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectAnnexBBlockFunctionNames(item, names, insideContainer);
    }
    return names;
  }

  if (node.type === "FunctionDeclaration" && insideContainer && node.id && node.id.name) {
    names.add(node.id.name);
  }

  const nextInsideContainer = insideContainer || ANNEX_B_CONTAINERS.has(node.type);
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    collectAnnexBBlockFunctionNames(value, names, nextInsideContainer);
  }

  return names;
}

function predeclareAnnexBRootBindings(context, names) {
  if (context.options.sourceType !== "script") {
    return;
  }

  for (const name of names) {
    const rootBinding = declareRootBinding(context, name, {
      declarationKind: "var",
      kind: "annexB-block-function",
    });
    if (!rootBinding.created) {
      continue;
    }
    const rootReference = resolveRootBindingReference(context, name);
    const undefinedRegister = compileLiteralValue(undefined, context);
    emit(context, [OpCode.INITVAR, rootReference.depth, rootReference.binding.slot, undefinedRegister]);
  }
}

function canExposeAnnexBBlockFunction(context, name) {
  if (context.options.sourceType !== "script") {
    return false;
  }

  for (let index = context.scopeStack.length - 2; index >= 1; index -= 1) {
    const scope = context.scopeStack[index];
    if (scope.bindings.has(name)) {
      return false;
    }
  }

  return true;
}

const ANNEX_B_CONTAINERS = new Set([
  "BlockStatement",
  "IfStatement",
  "SwitchStatement",
  "SwitchCase",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "CatchClause",
]);

module.exports = {
  canExposeAnnexBBlockFunction,
  collectAnnexBBlockFunctionNames,
  predeclareAnnexBRootBindings,
  withAnnexBBlockFunctionContext,
};

export {};
