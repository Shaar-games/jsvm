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