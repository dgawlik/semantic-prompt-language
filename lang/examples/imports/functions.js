import { assert } from 'spl-lang';

export function fib(n) {
    assert(Number.isInteger(n) && n >= 0, 'fib needs a non-negative integer');
    return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

export function factorial(n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}
