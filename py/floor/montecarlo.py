"""Teto de drawdown por Monte Carlo: embaralha a ordem das operações e mede o pior tombo plausível."""
import math
import random


def max_drawdown(pnls):
    """Maior queda, em moeda, do pico ao vale da curva acumulada (começando em zero)."""
    cumulative = peak = drawdown = 0.0
    for pnl in pnls:
        cumulative += pnl
        peak = max(peak, cumulative)
        drawdown = max(drawdown, peak - cumulative)
    return drawdown


def percentile(sorted_values, pct):
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * pct / 100
    lo = math.floor(k)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


def monte_carlo_drawdown(pnls, runs=5000, pct=95, seed=None):
    """Retorna o drawdown histórico e os percentis do drawdown em `runs` ordens embaralhadas.

    `ceiling` é o percentil `pct`: o valor sugerido para `max_drawdown` do robô.
    """
    pnls = [float(p) for p in pnls]
    rng = random.Random(seed)
    sequence = list(pnls)
    results = []
    for _ in range(runs if pnls else 0):
        rng.shuffle(sequence)
        results.append(max_drawdown(sequence))
    results.sort()
    return {
        "trades": len(pnls),
        "total": sum(pnls),
        "historical": max_drawdown(pnls),
        "p50": percentile(results, 50),
        "p95": percentile(results, 95),
        "p99": percentile(results, 99),
        "percentile": pct,
        "ceiling": percentile(results, pct),
    }
