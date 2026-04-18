// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { OpCode, emit, emitLabel, makeLabel, newRegister } = require("../utils");

async function compileSwitchStatement(node, context) {
  const discriminantRegister = await compileExpression(node.discriminant, context);
  const endLabel = makeLabel(context, "SWITCH_END");
  const caseLabels = node.cases.map((_caseNode, index) => makeLabel(context, `SWITCH_CASE_${index}`));
  const defaultIndex = node.cases.findIndex((caseNode) => caseNode.test === null);
  const defaultLabel = defaultIndex >= 0 ? caseLabels[defaultIndex] : endLabel;

  context.loopLabels.push({ start: endLabel, end: endLabel });

  for (let index = 0; index < node.cases.length; index += 1) {
    const caseNode = node.cases[index];
    if (caseNode.test === null) {
      continue;
    }
    const testRegister = await compileExpression(caseNode.test, context);
    const matchRegister = newRegister(context);
    emit(context, [OpCode.ISEQ, matchRegister, discriminantRegister, testRegister]);
    emit(context, [OpCode.JUMPT, matchRegister, caseLabels[index]]);
  }

  emit(context, [OpCode.JUMP, defaultLabel]);

  for (let index = 0; index < node.cases.length; index += 1) {
    emitLabel(context, caseLabels[index]);
    for (const statement of node.cases[index].consequent) {
      await compileStatement(statement, context);
    }
  }

  emitLabel(context, endLabel);
  context.loopLabels.pop();
}

module.exports = compileSwitchStatement;

export {};
