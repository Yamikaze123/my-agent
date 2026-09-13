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

The December 2024 anchor allows a consumer to calculate twelve monthly
returns for the 2025 period. The source is synthetic and should not be used
for investment decisions.
