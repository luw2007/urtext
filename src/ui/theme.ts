/**
 * UI visual tokens (urtext-20260724-ui-redesign §5.2). Single source of truth
 * for light/dark colors, type scale, spacing, and the responsive/focus/
 * reduced-motion rules that apply across every page. No imports — this file
 * is the leaf of the ui/ dependency graph.
 */
export const THEME_CSS = `:root{
  --bg:#fff; --fg:#1a1a1a; --muted:#6b6b6b; --border:#e3e3e3; --surface:#f7f7f7;
  --accent:#0550ae; --ok:#116329; --warn:#966400; --danger:#a40e26;
  --ok-bg:#eaf5ec; --warn-bg:#fff3d6; --danger-bg:#fbe9ec; --skip-bg:#0550ae; --skip-fg:#fff;
  --fs-s:13px; --fs-m:14px; --fs-l:16px; --fs-xl:20px; --lh:1.5;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
  --maxw:72rem;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#121417; --fg:#e6e6e6; --muted:#9a9a9a; --border:#2c2f33; --surface:#1b1e22;
  --accent:#539bf5; --ok:#57ab5a; --warn:#c69026; --danger:#e5534b;
  --ok-bg:#12261a; --warn-bg:#2b2111; --danger-bg:#2d1215;}}
*{box-sizing:border-box}
html{font-size:var(--fs-m)}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:var(--lh)}
main,header,nav,footer{display:block}
main{max-width:var(--maxw);margin:0 auto;padding:var(--sp-4)}
.skip{position:absolute;left:-9999px;top:0;padding:var(--sp-2) var(--sp-3);background:var(--skip-bg);color:var(--skip-fg);z-index:1}
.skip:focus{left:var(--sp-3);top:var(--sp-3)}
a{color:var(--accent)}
table a{color:var(--accent)}
table{background:var(--surface)}
code,pre{font-family:var(--mono)}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--border);padding:var(--sp-2) var(--sp-3);text-align:left}
[data-tone="muted"]{color:var(--muted);background:var(--bg)}
[data-tone="ok"],.diff-add{color:var(--ok);background:var(--ok-bg)}
[data-tone="warn"],.diff-hunk{color:var(--warn);background:var(--warn-bg)}
[data-tone="danger"],.diff-del,[role="alert"]{color:var(--danger);background:var(--danger-bg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button[disabled]{color:var(--muted);background:var(--bg);border:1px solid var(--border)}
pre{overflow-x:auto;white-space:pre}
@media (min-width:720px){nav{flex-wrap:nowrap}table{display:table}}
@media (max-width:719px){nav{flex-wrap:wrap}table{display:block;overflow-x:auto}}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`
