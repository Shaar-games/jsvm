// @ts-nocheck
const { OpCode, emit, resolveBreakTarget } = require("../utils");

async function compileBreakStatement(node, context) {
  const breakTarget = resolveBreakTarget(context, node.label ? node.label.name : null);
  if (!breakTarget) {
    throw new Error("BreakStatement used outside of a loop");
  }
  emit(context, [OpCode.JUMP, breakTarget]);
}

module.exports = compileBreakStatement;

export {};
