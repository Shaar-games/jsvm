function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomArray(size) {
    const arr = [];
    for (let i = 0; i < size; i++) {
        const randomInt = getRandomInt(0, 100);
        console.log(randomInt);
        arr.push(randomInt);
    }
    return arr;
}

function sortArray(arr) {
    return arr.sort((a, b) => a - b);
}

const randomArray = generateRandomArray(10);
console.log(randomArray);
console.log("Random Array:", randomArray);
console.log("Sorted Array:", sortArray(randomArray));
