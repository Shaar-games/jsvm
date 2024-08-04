{
    // Create an Object
    const person = {
        firstName: "John",
        lastName: "Doe",
        age: 50
    };

    // Destructuring
    let { firstName, lastName } = person;
}

{
    // Create an Object
    const person = {
        firstName: "John",
        lastName: "Doe",
        age: 50
    };

    // Destructuring
    let { lastName, firstName } = person;
}

{
    // Create an Object
    const person = {
        firstName: "John",
        lastName: "Doe",
        age: 50
    };

    // Destructuring
    let { firstName, lastName, country = "US" } = person;
}

{
    // Create an Object
    const person = {
        firstName: "John",
        lastName: "Doe",
        age: 50
    };

    // Destructuring
    let { lastName: name } = person;
}

{
    // Create a String
    let name = "W3Schools";

    // Destructuring
    let [a1, a2, a3, a4, a5] = name;
}

{
    // Create an Array
    const fruits = ["Bananas", "Oranges", "Apples", "Mangos"];

    // Destructuring
    let [fruit1, fruit2] = fruits;
}

{
    // Create an Array
    const fruits = ["Bananas", "Oranges", "Apples", "Mangos"];

    // Destructuring
    let [fruit1, , , fruit2] = fruits;
}

{
    // Create an Array
    const fruits = ["Bananas", "Oranges", "Apples", "Mangos"];
    // Destructuring
    let { [0]: fruit1, [1]: fruit2 } = fruits;

}

{
    // Create an Array
    const numbers = [10, 20, 30, 40, 50, 60, 70];

    // Destructuring
    const [a, b, ...rest] = numbers
}

{
    let firstName = "John";
    let lastName = "Doe";

    // Destructing
    [firstName, lastName] = [lastName, firstName]; // ne fonctionne pas
}
