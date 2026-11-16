// @CODEGEN sha256:63a8c1402b9798b9c5bddb266580ae8096505425bfb62dee3ef7da257007760f
function sieve(limit) {
    if (typeof limit !== 'number' || limit < 2) {
        return [];
    }
    const isPrime = new Array(limit + 1).fill(true);
    isPrime[0] = false;
    isPrime[1] = false;
    for (let i = 2; i * i <= limit; i++) {
        if (isPrime[i]) {
            for (let j = i * i; j <= limit; j += i) {
                isPrime[j] = false;
            }
        }
    }
    const primes = [];
    for (let i = 2; i <= limit; i++) {
        if (isPrime[i]) primes.push(i);
    }
    return primes;
}
