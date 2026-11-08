# Fixture inventory

| element                     | versions            | spec section                                     | JSON Pointer pattern | proposed disposition | test or reason                                                                  |
| --------------------------- | ------------------- | ------------------------------------------------ | -------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `BIN-01` Binary row         | 3.0.4, 3.1.2        | https://example.test/a<br>https://example.test/b | `/a`                 | implemented          | req-test: sends it; see BIN-02, BIN-03. src: x                                  |
| `BIN-02` Second row         | 3.0.4, 3.1.2, 3.2.1 | https://example.test/c                           | `/b`                 | refused              | diag-test: refuses it. src: x                                                   |
| `BIN-03` Pipe row `\|` kept | 3.2.1               | https://example.test/d                           | `/c`                 | informational        | metadata only. src: x                                                           |
| `BIN-04` Delegating row     | 3.0.4               | https://example.test/e                           | `/d`                 | implemented          | resolved by others; covered by: BIN-01, BIN-02; each names its own test. src: x |
| `BIN-05` Closing row        | 3.0.4               | https://example.test/f                           | `/e`                 | implemented          | covered by: BIN-02. src: x                                                      |

Rows derived from sources other than the two research files:

| id       | element         | source    | note               |
| -------- | --------------- | --------- | ------------------ |
| `DRV-01` | Derived element | somewhere | not an element row |
