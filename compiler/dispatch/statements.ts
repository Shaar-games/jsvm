// @ts-nocheck
async function compileStatement(node, context) {
  const handler = context.statementHandlers[node.type];
  if (!handler) {
    throw new Error(`Unsupported statement type: ${node.type}`);
  }
  return handler(node, context);
}

module.exports = {
  compileStatement,
};

export {};
