// @ts-nocheck
const { pushScope, popScope } = require("../context");
const { collectAnnexBBlockFunctionNames, predeclareAnnexBRootBindings } = require("../annex-b");
const { predeclareBlockBindings } = require("../block-bindings");
const { OpCode, emit } = require("../utils");

async function compileBlockStatement(node, context, options = {}) {
  const { compileStatement } = require("../dispatch/statements");
  const isFunctionBody = Boolean(options.isFunctionBody);

  if (!isFunctionBody) {
    pushScope(context);
    emit(context, [OpCode.PUSH_ENV]);
  }

  const hoistedStatements = node.body.filter((statement) => statement.type === "FunctionDeclaration");
  const remainingStatements = node.body.filter((statement) => statement.type !== "FunctionDeclaration");
  predeclareBlockBindings(context, node.body);

  if (context.options.sourceType === "script") {
    const names = isFunctionBody
      ? collectAnnexBBlockFunctionNames(node.body)
      : new Set(
          hoistedStatements
            .filter((statement) => statement.id && statement.id.name)
            .map((statement) => statement.id.name)
        );
    predeclareAnnexBRootBindings(context, names);
  }

  for (const statement of hoistedStatements) {
    await compileStatement(statement, context);
  }

  for (const statement of remainingStatements) {
    await compileStatement(statement, context);
  }

  if (!isFunctionBody) {
    emit(context, [OpCode.POP_ENV]);
    popScope(context);
  }
}

module.exports = {
  compileBlockStatement,
};

export {};
