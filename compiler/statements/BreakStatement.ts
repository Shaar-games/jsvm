// @ts-nocheck
const { OpCode, emit } = require("../utils");

async function compileBreakStatement(node, context) {
  if (context.loopLabels.length === 0) {
    throw new Error("BreakStatement used outside of a loop");
  }
  emit(context, [OpCode.JUMP, context.loopLabels[context.loopLabels.length - 1].end]);
}

module.exports = compileBreakStatement;

export {};
