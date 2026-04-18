// @ts-nocheck
const { compileBlockStatement } = require("./BlockStatement");
const { compileFunctionLike, initializeBinding } = require("../utils");
const {
  emitStoreGlobalBinding,
  emitStoreRootBinding,
  shouldExposeFunctionToGlobal,
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

  if (shouldExposeFunctionToGlobal(context) && (context.scopeStack.length > 1 || context.annexBBlockFunctionContext || context.options.scriptMode === "global")) {
    emitStoreRootBinding(context, node.id.name, closureRegister);
    emitStoreGlobalBinding(context, node.id.name, closureRegister);
  }
}

module.exports = compileFunctionDeclaration;

export {};
