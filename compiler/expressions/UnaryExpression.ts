// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, compileLiteralValue, newRegister, storeBindingValue } = require("../utils");

async function compileUnaryExpression(node, context) {
  const resultRegister = newRegister(context);

  if (node.operator === "delete") {
    if (node.argument.type === "MemberExpression") {
      const objectRegister = await compileExpression(node.argument.object, context);
      const propertyRegister = node.argument.computed
        ? await compileExpression(node.argument.property, context)
        : compileLiteralValue(node.argument.property.name, context);
      const undefinedRegister = compileLiteralValue(undefined, context);
      emit(context, [OpCode.SETFIELD, objectRegister, propertyRegister, undefinedRegister]);
      emit(context, [OpCode.BOOL, resultRegister, 1]);
      return resultRegister;
    }

    if (node.argument.type === "Identifier") {
      storeBindingValue(context, node.argument.name, compileLiteralValue(undefined, context));
      emit(context, [OpCode.BOOL, resultRegister, 1]);
      return resultRegister;
    }

    throw new Error(`Unsupported argument for delete: ${node.argument.type}`);
  }

  const argumentRegister = await compileExpression(node.argument, context);
  switch (node.operator) {
    case "-":
      emit(context, [OpCode.UNM, resultRegister, argumentRegister]);
      break;
    case "!":
      emit(context, [OpCode.NOT, resultRegister, argumentRegister]);
      break;
    case "+":
      emit(context, [OpCode.MOVE, resultRegister, argumentRegister]);
      break;
    case "~": {
      const allOnesRegister = compileLiteralValue(-1, context);
      emit(context, [OpCode.XOR, resultRegister, argumentRegister, allOnesRegister]);
      break;
    }
    case "typeof":
      emit(context, [OpCode.TYPEOF, resultRegister, argumentRegister]);
      break;
    case "void":
      emit(context, [OpCode.UNDEF, resultRegister]);
      break;
    default:
      throw new Error(`Unsupported unary operator: ${node.operator}`);
  }

  return resultRegister;
}

module.exports = compileUnaryExpression;

export {};
