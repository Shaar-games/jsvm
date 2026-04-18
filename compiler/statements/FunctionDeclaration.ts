// @ts-nocheck
const { compileBlockStatement } = require("./BlockStatement");
const { compileFunctionLike, initializeBinding } = require("../utils");

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
}

module.exports = compileFunctionDeclaration;

export {};
