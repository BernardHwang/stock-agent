Fixtures for moomoo API parsing, trimmed from live answers on 2026-11-24 (no account data).

- Market data (`/api/v1.0/quote/...`) answers `{"ret_code":0,"ret_msg":"success","data":{...}}`;
  an error is a non-zero `ret_code` (e.g. -3 "missing required parameter: start") with HTTP 200.
- Accounts and positions (`/api/v1.0/accounts/...`) answer `{"s":"ok","d":...}`.
- Trading days take `market`, `start`, `end`.
