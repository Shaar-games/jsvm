// @ts-nocheck
const { compileStatement } = require("../dispatch/statements");
const { emitLabel, makeLabel, popControlLabel, pushControlLabel } = require("../utils");

async function compileLabeledStatement(node, context) {
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
