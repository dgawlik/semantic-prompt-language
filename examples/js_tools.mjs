// Host JS tool module loaded via `--js-tools examples/js_tools.mjs`
export function score_risk({ amount_cents, account_age_days }) {
  const score = Number(amount_cents) / Math.max(1, Number(account_age_days) * 100);
  return {
    score: Math.min(1, score),
    flagged: score > 0.7,
  };
}
