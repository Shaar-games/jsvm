// @ts-nocheck
const { OpCode, emit } = require("../utils");

async function compileContinueStatement(node, context) {
  if (context.loopLabels.length === 0) {
    throw new Error("ContinueStatement used outside of a loop");
  }
  emit(context, [OpCode.JUMP, context.loopLabels[context.loopLabels.length - 1].start]);
}

module.exports = compileContinueStatement;

export {};
