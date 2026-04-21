// @ts-nocheck
const { declareBinding } = require("./context");
const { collectPatternBindingNames } = require("./pattern-bindings");

function predeclareBlockBindings(context, statements) {
  for (const statement of statements || []) {
    predeclareStatementBinding(context, statement);
  }
}

function predeclareStatementBinding(context, statement) {
  if (!statement) {
    return;
  }

  if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
    predeclareStatementBinding(context, statement.declaration);
    return;
  }

  if (statement.type === "ExportDefaultDeclaration" && statement.declaration) {
    predeclareStatementBinding(context, statement.declaration);
    return;
  }

  if (statement.type === "FunctionDeclaration" && statement.id) {
    declareBinding(context, statement.id.name, { declarationKind: "function" });
    return;
  }

  if (statement.type === "ClassDeclaration" && statement.id) {
    declareBinding(context, statement.id.name, { declarationKind: "class" });
    return;
  }

  if (statement.type === "VariableDeclaration") {
    for (const declaration of statement.declarations) {
      for (const name of collectPatternBindingNames(declaration.id)) {
        declareBinding(context, name, { declarationKind: statement.kind });
      }
    }
  }
}

module.exports = {
  predeclareBlockBindings,
};

export {};
