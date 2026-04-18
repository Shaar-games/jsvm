function Car(make, year) {
  this.make = make;
  this.year = year;
}

const car = new Car("Eagle", 1993);
console.log(car.make, car.year);
