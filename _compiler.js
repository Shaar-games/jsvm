const acorn = require('acorn');

// Enumération pour les opcodes
const OpCode = {
  KNUM: 'KNUM',
  ADDVN: 'ADDVN',
  ADDNV: 'ADDNV',
  ADDVV: 'ADDVV',
  ADDNN: 'ADDNN',
  MOV: 'MOV',
  KSTR: 'KSTR',
  KCDATA: 'KCDATA',
  KSHORT: 'KSHORT',
  KPRI: 'KPRI',
  KNULL: 'KNULL'
};

// Classe pour le compilateur de bytecode
class BytecodeCompiler {
  constructor() {
    this.bytecode = [];
    this.scopeStack = [{}]; // Pile de scopes, chaque scope est une map de variables et registres
    this.nextRegister = 0; // Pour assigner des registres de manière séquentielle
  }

  // Méthode principale pour compiler l'AST
  compile(ast) {
    this.visitNode(ast);
    return this.bytecode;
  }

  // Obtenir un registre pour une variable, en l'attribuant si nécessaire
  getRegisterForVariable(name) {
    // Chercher la variable dans les scopes actuels et parents
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      if (scope[name]) {
        return scope[name];
      }
    }
    throw new Error(`Variable ${name} is not declared`);
  }

  // Déclare une variable dans le scope actuel
  declareVariable(name) {
    const currentScope = this.scopeStack[this.scopeStack.length - 1];
    if (!currentScope[name]) {
      currentScope[name] = `R${this.nextRegister++}`;
    }
    return currentScope[name];
  }

  // Visiter un nœud de l'AST
  visitNode(node) {
    console.log(require('util').inspect(node , true , 1000 , true))
    const method = this[`visit${node.type}`];
    if (method) {
      method.call(this, node);
    } else {
      throw new Error(`Unhandled node type: ${node.type}`);
    }
  }

  // Visiter un programme
  visitProgram(node) {
    node.body.forEach(n => this.visitNode(n));
  }

  // Visiter une déclaration de variable
  visitVariableDeclaration(node) {
    node.declarations.forEach(n => this.visitVariableDeclarator(n));
  }

  // Visiter un déclarateur de variable
  visitVariableDeclarator(node) {
    const varName = node.id.name;
    const destReg = this.declareVariable(varName); // Déclare la variable dans le scope actuel

    if (node.init) {
      // Si la variable a une initialisation, visite cette initialisation
      this.visitNode(node.init, varName);
    } else {
      // Si pas d'initialisation, initialise à zéro (ou une valeur par défaut)
      this.bytecode.push(`${OpCode.KNUM} ${destReg}, 0`);
    }
  }

  // Visiter une expression d'affectation
  visitAssignmentExpression(node) {
    const { left, right, operator } = node;

    if (operator === '=') {
      const destReg = this.getRegisterForVariable(left.name);

      // Gérer l'assignation simple
      if (right.type === 'Literal') {
        this.visitLiteral(right, destReg);
      } else if (right.type === 'Identifier') {
        const sourceReg = this.getRegisterForVariable(right.name);
        this.bytecode.push(`${OpCode.MOV} ${destReg}, ${sourceReg}`);
      } else {
        this.visitNode(right, left.name);
      }
    }
  }

  // Visiter une expression binaire
  visitBinaryExpression(node, varName) {
    const { left, right, operator } = node;
    let leftReg, rightReg, destReg;

    destReg = this.getRegisterForVariable(varName);

    if (operator === '+') {
      if (left.type === 'Literal' && right.type === 'Literal') {
        this.bytecode.push(`${OpCode.ADDNN} ${destReg}, ${left.value}, ${right.value}`);
      } else if (left.type === 'Identifier' && right.type === 'Literal') {
        leftReg = this.getRegisterForVariable(left.name);
        this.bytecode.push(`${OpCode.ADDVN} ${destReg}, ${leftReg}, ${right.value}`);
      } else if (left.type === 'Literal' && right.type === 'Identifier') {
        rightReg = this.getRegisterForVariable(right.name);
        this.bytecode.push(`${OpCode.ADDNV} ${destReg}, ${left.value}, ${rightReg}`);
      } else if (left.type === 'Identifier' && right.type === 'Identifier') {
        leftReg = this.getRegisterForVariable(left.name);
        rightReg = this.getRegisterForVariable(right.name);
        this.bytecode.push(`${OpCode.ADDVV} ${destReg}, ${leftReg}, ${rightReg}`);
      }
    }
  }

  // Visiter un bloc de code (BlockStatement)
  visitBlockStatement(node) {
    // Entrer dans un nouveau scope
    this.scopeStack.push({});

    node.body.forEach(n => this.visitNode(n));

    // Sortir du scope actuel
    this.scopeStack.pop();
  }

  // Visiter une instruction d'expression
  visitExpressionStatement(node) {
    this.visitNode(node.expression); // Traite l'expression contenue
  }

  // Visiter un littéral
  visitLiteral(node, destReg) {
    if (typeof node.value === 'number') {
      this.bytecode.push(`${OpCode.KNUM} ${destReg}, ${node.value}`);
    } else if (typeof node.value === 'string') {
      this.bytecode.push(`${OpCode.KSTR} ${destReg}, "${node.value}"`);
    } else if (typeof node.value === 'boolean') {
      const priValue = node.value ? 2 : 1; // true -> 2, false -> 1
      this.bytecode.push(`${OpCode.KPRI} ${destReg}, ${priValue}`);
    } else if (node.value === null) {
      this.bytecode.push(`${OpCode.KNULL} ${destReg}`);
    }
  }
}

// Exemple d'utilisation
let code = `
  let a = 1 + 1;
  let b = a + 2;
  let c = 3 + b;
  let d = a + b;
  let e = a + b;
  e = 5;
  e = b;

  {
    let e = 0;
  }
`;

const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });

const compiler = new BytecodeCompiler();
const bytecode = compiler.compile(ast);

console.log(bytecode.join('\n'));
