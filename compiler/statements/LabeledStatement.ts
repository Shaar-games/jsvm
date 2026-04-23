// @ts-nocheck
const { compileStatement } = require("../dispatch/statements");
const { emitLabel, makeLabel, popControlLabel, pushControlLabel } = require("../utils");

const ITERATION_STATEMENTS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

async function compileLabeledStatement(node, context) {
  if (ITERATION_STATEMENTS.has(node.body.type)) {
    const previousPendingLoopLabel = context.pendingLoopLabel || null;
    context.pendingLoopLabel = node.label.name;
    try {
      await compileStatement(node.body, context);
    } finally {
      context.pendingLoopLabel = previousPendingLoopLabel;
    }
    return;
  }

  const endLabel = makeLabel(context, `LABEL_${node.label.name}_END`);
  pushControlLabel(context, {
    label: node.label.name,
    breakLabel: endLabel,
  });
  await compileStatement(node.body, context);
  emitLabel(context, endLabel);
  popControlLabel(context);
}

module.exports = compileLabeledStatement;

export {};
