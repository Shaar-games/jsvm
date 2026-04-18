// @ts-nocheck
const { pushScope, popScope } = require("../context");
const { OpCode, emit } = require("../utils");

async function compileBlockStatement(node, context, options = {}) {
  const { compileStatement } = require("../dispatch/statements");
  const isFunctionBody = Boolean(options.isFunctionBody);

  if (!isFunctionBody) {
    pushScope(context);
    emit(context, [OpCode.PUSH_ENV]);
  }

  for (const statement of node.body) {
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
