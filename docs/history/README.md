# Design records

Superseded documents, kept because the reasoning is still useful and because
two of them were wrong in instructive ways.

| | |
|---|---|
| [personal-tier.md](personal-tier.md) | The design for a browser tier, written before any of it was built. Most of it became the pad |
| [wasm-in-the-browser.md](wasm-in-the-browser.md) | Whether WASM could replace ajar's model. Concluded no — correctly, and for the wrong reason. The first postscript says which of its four walls stood; the second records that one of those has since fallen, and that it was never the wall it looked like |
| [unified-ui-plan.md](unified-ui-plan.md) | A plan to move both products to React. UI-01 shipped as plain TypeScript; the React scaffold was removed before merge because it took the pad's entry chunk from 18 KB to 235 KB to render a placeholder into a hidden div. On hold from UI-02 |

These are not maintained, and they are not edited when the world moves —
`wasm-in-the-browser.md` carries a dated addendum rather than a correction in
place, because the value of a record is that it says what was believed at the
time. Where they disagree with [`../dev/`](../dev/), the dev documentation is
right.
