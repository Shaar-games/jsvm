// @ts-nocheck
const { pushScope, popScope, declareRootBinding, resolveRootBindingReference } = require("../context");
const { OpCode, emit, compileLiteralValue } = require("../utils");

async function compileBlockStatement(node, context, options = {}) {
  const { compileStatement } = require("../dispatch/statements");
  const isFunctionBody = Boolean(options.isFunctionBody);

  if (!isFunctionBody) {
    pushScope(context);
    emit(context, [OpCode.PUSH_ENV]);
  }

  const hoistedStatements = node.body.filter((statement) => statement.type === "FunctionDeclaration");
  const remainingStatements = node.body.filter((statement) => statement.type !== "FunctionDeclaration");

  if (!isFunctionBody && context.options.sourceType === "script") {
    for (const statement of hoistedStatements) {
      if (!statement.id || !statement.id.name) {
        continue;
      }
      const rootBinding = declareRootBinding(context, statement.id.name, {
        declarationKind: "var",
        kind: "annexB-block-function",
      });
      if (!rootBinding.created) {
        continue;
      }
      const rootReference = resolveRootBindingReference(context, statement.id.name);
      const undefinedRegister = compileLiteralValue(undefined, context);
      emit(context, [OpCode.INITVAR, rootReference.depth, rootReference.binding.slot, undefinedRegister]);
    }
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
