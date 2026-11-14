// @CODEGEN sha256:7ea03b00dc318ae56ff81791fb68046b29cb0ce252c3b373d2ffee76bb22273d
function sieve(number) {
    if (typeof number !== 'number' || number < 2) {
        return [];
    }
    const isPrime = new Array(number + 1).fill(true);
    isPrime[0] = false;
    isPrime[1] = false;
    for (let i = 2; i * i <= number; i++) {
        if (isPrime[i]) {
            for (let j = i * i; j <= number; j += i) {
                isPrime[j] = false;
            }
        }
    }
    const primes = [];
    for (let i = 2; i <= number; i++) {
        if (isPrime[i]) primes.push(i);
    }
    return primes;
}
