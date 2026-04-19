// @ts-nocheck
const { OpCode, emit, resolveContinueTarget } = require("../utils");

async function compileContinueStatement(node, context) {
  const continueTarget = resolveContinueTarget(context, node.label ? node.label.name : null);
  if (!continueTarget) {
    throw new Error("ContinueStatement used outside of a loop");
  }
  emit(context, [OpCode.JUMP, continueTarget]);
}

module.exports = compileContinueStatement;

export {};
