let acorn = require("acorn");
const escodegen = require('escodegen');
const fs = require("fs");
const testFolder = "./test/";
const files = fs.readdirSync(testFolder);

const { interpretProgram , interpretBlockStatement } = require('./interpreter.js');

const context = {
    Math: Math,
    console: console
  };

files.forEach((file) => {
    const data = fs.readFileSync(testFolder + file, "utf8");
    const ast = acorn.parse(data , { ecmaVersion: 2022 , sourceType: "module" });
    //console.log(JSON.stringify(ast, null, 2));
    const generatedCode = escodegen.generate(ast);
    console.log(generatedCode);

    interpretBlockStatement(ast, context);
});
