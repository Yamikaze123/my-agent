# Finance regression fixture

`finance-regression-v1.json` is a synthetic, versioned monthly price fixture
for reproducible finance analysis tests. It contains an anchor price from
December 2024 followed by twelve 2025 month-end observations for AAPL, MSFT,
and TSLA.

The values are intentionally not live market data. They are suitable for
deterministic returns, volatility, drawdown, chart, and provenance tests. The
manifest records the SHA-256 hash of the canonical row content. The fixture
connector verifies that hash before returning any data.

This fixture is for evaluation, offline development, and explicitly
reproducible requests. Ordinary user finance requests should continue to use
the live `yfinance` connector, including historical calendar ranges such as 2025.

`finance-regression-v2.json` is a held-out-quality candidate with irregular
month spacing and a pronounced drawdown/recovery episode. Its manifest is
`finance-regression-v2-manifest.json`; compute and record its content hash
before freezing the evaluation batch.

The `defective/` directory contains separate quality fixtures for duplicate
rows, out-of-order dates, a missing month, non-positive prices, mixed currency,
and prompt-injection text. Expected findings are recorded in its manifest, and
a manifest-driven test runs every listed file through the Phase 5 profiler and
quality rules. The rules block duplicate rows, out-of-order dates, non-positive
prices, and mixed currency. A missing month and prompt-injection text produce
non-blocking warnings (`missing-period` and `untrusted-content-present`), so the
v2 fixture's irregular spacing is disclosed rather than rejected (see
`doc/ADR-004`); all cell and column text is treated as inert data.
Static fixtures use `freshness=static`; “stale” applies only to dynamic sources
whose `observedAt` exceeds the configured freshness window.

The December 2024 anchor allows a consumer to calculate twelve monthly
returns for the 2025 period. The source is synthetic and should not be used
for investment decisions.
