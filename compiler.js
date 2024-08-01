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
  KPRI: 'KPRI',
  KNULL: 'KNULL',
  PRINT: 'PRINT',
  ISLT: 'ISLT',
  ISGE: 'ISGE',
  ISLE: 'ISLE',
  ISGT: 'ISGT',
  ISEQV: 'ISEQV',
  ISNEV: 'ISNEV',
  JMP: 'JMP'
};

// Fonction principale pour compiler un programme
async function compileProgram(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const context = {
    bytecode: [],
    scopeStack: [new Map()], // Pile de scopes avec le scope global initialisé
    nextRegister: 0,
    labelCounter: 0
  };
  await compileBlockStatement(ast, context);
  return context.bytecode;
}

// Fonction pour obtenir un registre pour une variable
function getRegister(context, name) {
  // Chercher la variable dans le scope actuel
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  if (!currentScope.has(name)) {
    // Attribuer un nouveau registre si la variable n'est pas déclarée dans le scope actuel
    const register = `R${context.nextRegister++}`;
    currentScope.set(name, register);
  }
  return currentScope.get(name);
}

// Fonction pour compiler un bloc de code
async function compileBlockStatement(node, context) {
  // Créer un nouveau scope pour ce bloc
  context.scopeStack.push(new Map());

  for (const statement of node.body) {
    await compileStatement(statement, context);
  }

  // Sortir du scope actuel
  context.scopeStack.pop();
}

// Fonction pour compiler une instruction
async function compileStatement(node, context) {
  switch (node.type) {
    case 'VariableDeclaration':
      await compileVariableDeclaration(node, context);
      break;
    case 'ExpressionStatement':
      await compileExpression(node.expression, context);
      break;
    case 'ReturnStatement':
      await compileExpression(node.argument, context);
      break;
    case 'IfStatement':
      await compileIfStatement(node, context);
      break;
    case 'BlockStatement':
      await compileBlockStatement(node, context);
      break;
    default:
      throw new Error(`Unsupported statement type: ${node.type}`);
  }
}

// Fonction pour compiler une déclaration de variable
async function compileVariableDeclaration(node, context) {
  for (const declaration of node.declarations) {
    const name = declaration.id.name;
    const destReg = getRegister(context, name);
    const value = await compileExpression(declaration.init, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${value}`);
  }
}

// Fonction pour compiler une expression
async function compileExpression(node, context) {
  switch (node.type) {
    case 'Literal':
      return compileLiteral(node, context);
    case 'Identifier':
      return resolveIdentifier(context, node.name);
    case 'BinaryExpression':
      return await compileBinaryExpression(node, context);
    case 'AssignmentExpression':
      return await compileAssignmentExpression(node, context);
    case 'CallExpression':
      return await compileCallExpression(node, context);
    default:
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
}

// Fonction pour compiler un littéral
function compileLiteral(node, context) {
  const register = `R${context.nextRegister++}`;
  if (typeof node.value === 'number') {
    context.bytecode.push(`${OpCode.KNUM} ${register}, ${node.value}`);
  } else if (typeof node.value === 'string') {
    context.bytecode.push(`${OpCode.KSTR} ${register}, "${node.value}"`);
  } else if (typeof node.value === 'boolean') {
    const priValue = node.value ? 2 : 1; // true -> 2, false -> 1
    context.bytecode.push(`${OpCode.KPRI} ${register}, ${priValue}`);
  } else if (node.value === null) {
    context.bytecode.push(`${OpCode.KNULL} ${register}`);
  }
  return register;
}

// Résoudre un identifiant en cherchant dans les scopes
function resolveIdentifier(context, name) {
  for (let i = context.scopeStack.length - 1; i >= 0; i--) {
    const scope = context.scopeStack[i];
    if (scope.has(name)) {
      return scope.get(name);
    }
  }
  throw new Error(`Identifier ${name} not found`);
}

// Fonction pour compiler une expression binaire
async function compileBinaryExpression(node, context) {
  const leftReg = await compileExpression(node.left, context);
  const rightReg = await compileExpression(node.right, context);
  const resultReg = `R${context.nextRegister++}`;

  switch (node.operator) {
    case '+':
      context.bytecode.push(`${OpCode.ADDVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '-':
      context.bytecode.push(`SUBVV ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '*':
      context.bytecode.push(`MULVV ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '/':
      context.bytecode.push(`DIVVV ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '<':
      context.bytecode.push(`${OpCode.ISLT} ${leftReg}, ${rightReg}`);
      break;
    case '>':
      context.bytecode.push(`${OpCode.ISGT} ${leftReg}, ${rightReg}`);
      break;
    case '<=':
      context.bytecode.push(`${OpCode.ISLE} ${leftReg}, ${rightReg}`);
      break;
    case '>=':
      context.bytecode.push(`${OpCode.ISGE} ${leftReg}, ${rightReg}`);
      break;
    case '==':
      context.bytecode.push(`${OpCode.ISEQV} ${leftReg}, ${rightReg}`);
      break;
    case '!=':
      context.bytecode.push(`${OpCode.ISNEV} ${leftReg}, ${rightReg}`);
      break;
    default:
      throw new Error(`Unsupported binary operator: ${node.operator}`);
  }
  return resultReg;
}

// Fonction pour compiler une expression d'affectation
async function compileAssignmentExpression(node, context) {
  if (node.left.type !== 'Identifier') {
    throw new Error(`Unsupported left-hand side in assignment: ${node.left.type}`);
  }

  const destReg = resolveIdentifier(context, node.left.name);

  // Vérifie si le côté droit est une constante ou une variable
  if (node.right.type === 'Literal') {
    const literalReg = compileLiteral(node.right, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${literalReg}`);
  } else if (node.right.type === 'Identifier') {
    const sourceReg = resolveIdentifier(context, node.right.name);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${sourceReg}`);
  } else {
    const valueReg = await compileExpression(node.right, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${valueReg}`);
  }

  return destReg;
}

// Fonction pour compiler une instruction if
async function compileIfStatement(node, context) {
  const testReg = await compileExpression(node.test, context);
  const consequent = node.consequent;
  const alternate = node.alternate;
  // Comparaison suivie d'un saut conditionnel
  context.bytecode.push(`JMP :${++context.labelCounter}:`);
  //context.bytecode.push(`${testReg}:`);
  await compileStatement(consequent, context);
  context.bytecode.push(`:${context.labelCounter}:`);
  if (alternate) {
    await compileStatement(alternate, context);
  }
  
}

// Fonction pour compiler un appel de fonction
async function compileCallExpression(node, context) {
  const calleeReg = await compileExpression(node.callee, context);
  const args = await Promise.all(node.arguments.map(arg => compileExpression(arg, context)));
  context.bytecode.push(`CALL ${calleeReg}, ${args.join(', ')}`);
  const resultReg = `R${context.nextRegister++}`;
  context.bytecode.push(`MOV ${resultReg}, RRET`);
  return resultReg;
}

// Exemple d'utilisation
(async () => {
  let code = `
    let a = 1 + 1;
    let b = a + 2;
    {
      let c = 3 + b;
      if (c > a) {
        let d = c - a;
        b = d + a;
      }
    }
    let e = a + b;

    {
      b = 1;
      b = 2
    }

    if(true){
        let x = 1
    }else{
        let y = 2
    }

    function fun(){

    }
  `;

  const bytecode = await compileProgram(code);
  console.log(bytecode.join('\n'));
})();
