// @ts-nocheck
const { compileStatement } = require("../dispatch/statements");
const { popScope, pushScope } = require("../context");
const { OpCode, emit, emitLabel, initializeBinding, makeLabel, newRegister } = require("../utils");

async function compileTryStatement(node, context) {
  const catchLabel = makeLabel(context, "CATCH");
  const endLabel = makeLabel(context, "ENDTRY");

  emit(context, [OpCode.SETUP_TRY, catchLabel]);
  await compileStatement(node.block, context);
  emit(context, [OpCode.END_TRY]);
  emit(context, [OpCode.JUMP, endLabel]);

  emitLabel(context, catchLabel);
  if (node.handler) {
    pushScope(context);
    emit(context, [OpCode.PUSH_ENV]);

    if (node.handler.param && node.handler.param.type === "Identifier") {
      const errorRegister = newRegister(context);
      emit(context, [OpCode.GETERR, errorRegister]);
      initializeBinding(context, node.handler.param.name, errorRegister, { declarationKind: "catch" });
    }

    for (const statement of node.handler.body.body) {
      await compileStatement(statement, context);
    }

    emit(context, [OpCode.POP_ENV]);
    popScope(context);
  }

  if (node.finalizer) {
    await compileStatement(node.finalizer, context);
  }

  emitLabel(context, endLabel);
}

module.exports = compileTryStatement;

export {};
