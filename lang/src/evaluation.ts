function termCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [term] of text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return counts;
}

export function tfIdfCosineSimilarity(expected: string, actual: string): number {
    expected = expected.normalize('NFKC').toLowerCase().trim();
    actual = actual.normalize('NFKC').toLowerCase().trim();
    const expectedCounts = termCounts(expected);
    const actualCounts = termCounts(actual);
    if (!expectedCounts.size || !actualCounts.size) return expected === actual ? 1 : 0;

    let dotProduct = 0;
    let expectedSquared = 0;
    let actualSquared = 0;
    for (const term of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
        const expectedCount = expectedCounts.get(term) ?? 0;
        const actualCount = actualCounts.get(term) ?? 0;
        const documentFrequency = Number(expectedCount > 0) + Number(actualCount > 0);
        // The two inputs are the corpus; smoothing keeps shared terms informative.
        const idf = 1 + Math.log(3 / (1 + documentFrequency));
        const expectedWeight = expectedCount * idf;
        const actualWeight = actualCount * idf;
        dotProduct += expectedWeight * actualWeight;
        expectedSquared += expectedWeight * expectedWeight;
        actualSquared += actualWeight * actualWeight;
    }
    return Math.min(1, dotProduct / Math.sqrt(expectedSquared * actualSquared));
}
