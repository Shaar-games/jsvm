console.log(1 + 2);
console.log(3 - 4);
console.log("1", 2);
console.log("1", [2]);
console.log("1", [2]);

function test() {
  return [1,2,3];
}

const a = test();

console.log("Random Array:", a);

a[0] = 0;
a.push(4);

console.log(a[0]);
console.log(a);

const b = a[0];
for (let i = 0; i < 50; i++) {
    b = b + 1;
}

console.log(b);
console.log(c);
var c = 1;
c = 2;

async function testAsync() {
    return 1;
}
console.log("testAsync");
console.log(testAsync() , "Promise ?");
console.log(await testAsync());
//console.log("testAsync",await testAsync());


{
    let a = 5;
    
}

console.log(a);