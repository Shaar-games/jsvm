// @ts-nocheck
const util = require("util");
const { OpCode, DATA } = require("../bytecode/opcodes");
const { createContext, serializeFunctions, serializeScopeBindings } = require("./context");
const { compileBlockStatement } = require("./statements/BlockStatement");
const { parseSource } = require("./parser");

const expressionHandlers = {
  Literal: require("./expressions/Literal"),
  Identifier: require("./expressions/Identifier"),
  BinaryExpression: require("./expressions/BinaryExpression"),
  AssignmentExpression: require("./expressions/AssignmentExpression"),
  CallExpression: require("./expressions/CallExpression"),
  ArrayExpression: require("./expressions/ArrayExpression"),
  MemberExpression: require("./expressions/MemberExpression"),
  UpdateExpression: require("./expressions/UpdateExpression"),
  ObjectExpression: require("./expressions/ObjectExpression"),
  LogicalExpression: require("./expressions/LogicalExpression"),
  UnaryExpression: require("./expressions/UnaryExpression"),
  AwaitExpression: require("./expressions/AwaitExpression"),
  FunctionExpression: require("./expressions/FunctionExpression"),
  ArrowFunctionExpression: require("./expressions/ArrowFunctionExpression"),
  SequenceExpression: require("./expressions/SequenceExpression"),
  ImportExpression: require("./expressions/ImportExpression"),
  ThisExpression: require("./expressions/ThisExpression"),
  NewExpression: require("./expressions/NewExpression"),
  ClassExpression: require("./expressions/ClassExpression"),
  ConditionalExpression: require("./expressions/ConditionalExpression"),
  TemplateLiteral: require("./expressions/TemplateLiteral"),
  SpreadElement: require("./expressions/SpreadElement"),
  YieldExpression: require("./expressions/YieldExpression"),
};

const statementHandlers = {
  Program: async (node, context) => compileBlockStatement(node, context, { isFunctionBody: true }),
  BlockStatement: async (node, context) => compileBlockStatement(node, context),
  VariableDeclaration: require("./statements/VariableDeclaration"),
  ImportDeclaration: require("./statements/ImportDeclaration"),
  ExportNamedDeclaration: require("./statements/ExportNamedDeclaration"),
  ExpressionStatement: require("./statements/ExpressionStatement"),
  ReturnStatement: require("./statements/ReturnStatement"),
  IfStatement: require("./statements/IfStatement"),
  WhileStatement: require("./statements/WhileStatement"),
  DoWhileStatement: require("./statements/DoWhileStatement"),
  ForStatement: require("./statements/ForStatement"),
  ForOfStatement: require("./statements/ForOfStatement"),
  ForInStatement: require("./statements/ForInStatement"),
  FunctionDeclaration: require("./statements/FunctionDeclaration"),
  ClassDeclaration: require("./statements/ClassDeclaration"),
  BreakStatement: require("./statements/BreakStatement"),
  ContinueStatement: require("./statements/ContinueStatement"),
  EmptyStatement: require("./statements/EmptyStatement"),
  ThrowStatement: require("./statements/ThrowStatement"),
  TryStatement: require("./statements/TryStatement"),
  ExportDefaultDeclaration: require("./statements/ExportDefaultDeclaration"),
  SwitchStatement: require("./statements/SwitchStatement"),
  LabeledStatement: require("./statements/LabeledStatement"),
  WithStatement: require("./statements/WithStatement"),
};

async function compileProgram(code, options = {}) {
  const { sourceType = "module", debug = false, filename = null } = options;
  const ast = parseSource(code, { sourceType });
  const context = createContext({
    ...options,
    scriptMode: options.scriptMode || (sourceType === "script" ? "global" : "module"),
  });
  context.expressionHandlers = expressionHandlers;
  context.statementHandlers = statementHandlers;

  if (debug) {
    console.log(util.inspect(ast, false, null, true));
  }

  await statementHandlers.Program(ast, context);

  const program = {
    sourceType,
    scriptMode: context.options.scriptMode,
    filename,
    scopeBindings: serializeScopeBindings(context.scopeStack[0]),
    staticSection: {
      values: context.staticSection.values.slice(),
    },
    entry: context.bytecode.array.slice(),
    functions: serializeFunctions(context.functions),
  };

  context.bytecode.program = program;
  return context.bytecode;
}

module.exports = {
  compileProgram,
  OpCode,
  DATA,
};

export {};
