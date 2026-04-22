// @ts-nocheck
const { compileBlockStatement } = require("./BlockStatement");
const { compileFunctionLike, initializeBinding } = require("../utils");
const { canExposeAnnexBBlockFunction } = require("../annex-b");
const {
  emitStoreGlobalBinding,
  emitStoreRootBinding,
  shouldExposeFunctionToGlobal,
  shouldExposeFunctionToRoot,
} = require("../script-bindings");

async function compileFunctionDeclaration(node, context) {
  const closureRegister = await compileFunctionLike(
    node,
    context,
    node.id.name,
    async (functionContext) => {
      await compileBlockStatement(node.body, functionContext, { isFunctionBody: true });
    }
  );

  initializeBinding(context, node.id.name, closureRegister, { declarationKind: "function" });
  const canExposeAnnexB = canExposeAnnexBBlockFunction(context, node.id.name);
  const isTopLevelGlobalFunction =
    context.options.sourceType === "script" &&
    context.options.scriptMode === "global" &&
    context.scopeStack.length === 1;

  if (isTopLevelGlobalFunction) {
    emitStoreGlobalBinding(context, node.id.name, closureRegister);
  }

  if (canExposeAnnexB && shouldExposeFunctionToRoot(context) && (context.scopeStack.length > 1 || context.annexBBlockFunctionContext || context.options.scriptMode === "global")) {
    emitStoreRootBinding(context, node.id.name, closureRegister);
  }
  if (!isTopLevelGlobalFunction && canExposeAnnexB && shouldExposeFunctionToGlobal(context) && (context.scopeStack.length > 1 || context.annexBBlockFunctionContext || context.options.scriptMode === "global")) {
    emitStoreGlobalBinding(context, node.id.name, closureRegister);
  }
}

module.exports = compileFunctionDeclaration;

export {};
