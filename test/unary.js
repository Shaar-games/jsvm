{
    const x = 1;
    const y = -1;

    console.log(+x);
    // Expected output: 1

    console.log(+y);
    // Expected output: -1

    console.log(+'');
    // Expected output: 0

    console.log(+true);
    // Expected output: 1

    console.log(+false);
    // Expected output: 0

    console.log(+'hello');
    // Expected output: NaN
}

{
    const x = 4;
    const y = -x;

    console.log(y);
    // Expected output: -4

    const a = '4';
    const b = -a;

    console.log(b);
    // Expected output: -4

}