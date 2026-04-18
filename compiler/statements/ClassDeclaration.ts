// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, compileLiteralValue, emit, initializeBinding, newRegister } = require("../utils");

async function compileClassDefinition(node, context, options = {}) {
  const classRegister = newRegister(context);
  const nameRegister = node.id ? compileLiteralValue(node.id.name, context) : "null";
  const superRegister = node.superClass ? await compileExpression(node.superClass, context) : "null";
  emit(context, [OpCode.CLASS, classRegister, nameRegister, superRegister]);

  for (const element of node.body.body) {
    if (element.type !== "MethodDefinition") {
      throw new Error(`Unsupported class element: ${element.type}`);
    }

    const keyRegister = element.computed
      ? await compileExpression(element.key, context)
      : compileLiteralValue(element.key.name || element.key.value, context);
    const functionNode = {
      type: element.value.type,
      id: null,
      params: element.value.params,
      body: element.value.body,
    };
    const methodRegister = await compileExpression(functionNode, context);
    emit(context, [
      OpCode.SETMETHOD,
      classRegister,
      keyRegister,
      methodRegister,
      element.kind,
      element.static ? 1 : 0,
    ]);
  }

  if (options.bindName !== false && node.id) {
    initializeBinding(context, node.id.name, classRegister, { declarationKind: "class" });
  }

  return classRegister;
}

async function compileClassDeclaration(node, context) {
  await compileClassDefinition(node, context);
}

module.exports = compileClassDeclaration;
module.exports.compileClassDefinition = compileClassDefinition;

export {};
