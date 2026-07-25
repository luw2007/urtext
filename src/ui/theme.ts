/**
 * UI visual tokens (urtext-20260724-ui-redesign §5.2). Single source of truth
 * for light/dark colors, type scale, spacing, and the responsive/focus/
 * reduced-motion rules that apply across every page. No imports — this file
 * is the leaf of the ui/ dependency graph.
 */
export const THEME_CSS = `:root{
  --canvas:#f8fafd; --surface:#fff; --surface-container:#f0f4f9; --surface-container-high:#e9eef6;
  --primary:#0b57d0; --primary-container:#d3e3fd; --on-primary:#fff; --on-primary-container:#041e49;
  --fg:#1f1f1f; --muted:#444746; --outline:#c4c7c5; --outline-variant:#e1e3e1;
  --ok:#116329; --warn:#7a5200; --danger:#a40e26;
  --ok-bg:#e6f4ea; --warn-bg:#fef7e0; --danger-bg:#fce8e6; --skip-bg:#0b57d0; --skip-fg:#fff;
  --fs-s:13px; --fs-m:14px; --fs-l:16px; --fs-xl:22px; --lh:1.5;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;
  --radius-s:8px; --radius-m:12px; --radius-l:16px;
  --shadow-1:0 1px 2px rgb(60 64 67 / .08),0 1px 3px 1px rgb(60 64 67 / .06);
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:Arial,"Helvetica Neue",system-ui,-apple-system,sans-serif;
  --maxw:75rem;
}
@media (prefers-color-scheme: dark){:root{
  --canvas:#111318; --surface:#1b1b1f; --surface-container:#202124; --surface-container-high:#282a2d;
  --primary:#a8c7fa; --primary-container:#0842a0; --on-primary:#062e6f; --on-primary-container:#d3e3fd;
  --fg:#e3e3e3; --muted:#c4c7c5; --outline:#8e918f; --outline-variant:#444746;
  --ok:#81c995; --warn:#fdd663; --danger:#f28b82;
  --ok-bg:#16351f; --warn-bg:#3c2f05; --danger-bg:#4c1d1d;
  --shadow-1:0 1px 2px rgb(0 0 0 / .3),0 2px 6px 2px rgb(0 0 0 / .15);
}}
*{box-sizing:border-box}
html{font-size:var(--fs-m);background:var(--canvas)}
body{margin:0;min-height:100vh;background:var(--canvas);color:var(--fg);font-family:var(--sans);line-height:var(--lh)}
main,header,nav,footer{display:block}
body>header{min-height:64px;display:flex;align-items:center;gap:var(--sp-3);padding:0 max(var(--sp-4),calc((100% - var(--maxw))/2));background:var(--surface);border-bottom:1px solid var(--outline-variant)}
body>header h1{margin:0;font-size:var(--fs-xl);font-weight:500;letter-spacing:-.2px}
body>header code{padding:var(--sp-1) var(--sp-2);border-radius:var(--radius-s);background:var(--surface-container);color:var(--muted);font-size:var(--fs-s)}
body>header small{margin-left:auto;color:var(--muted)}
body>nav{min-height:52px;display:flex;align-items:center;gap:var(--sp-1);padding:0 max(var(--sp-4),calc((100% - var(--maxw))/2));overflow-x:auto;background:var(--surface);border-bottom:1px solid var(--outline-variant);white-space:nowrap}
body>nav a{min-height:40px;display:inline-flex;align-items:center;padding:0 var(--sp-3);border-radius:999px;color:var(--muted);font-weight:500;text-decoration:none}
body>nav a:hover{background:var(--surface-container);color:var(--fg)}
body>nav .nav-refresh{margin-left:auto;color:var(--primary)}
body>nav a[aria-current=page]{background:var(--primary-container);color:var(--on-primary-container)}
main{max-width:var(--maxw);margin:var(--sp-5) auto;padding:var(--sp-5);border:1px solid var(--outline-variant);border-radius:var(--radius-l);background:var(--surface);box-shadow:var(--shadow-1)}
main>section+section,main>details+section,main>section+details{margin-top:var(--sp-5)}
h2{margin:0 0 var(--sp-4);font-size:var(--fs-xl);font-weight:500;letter-spacing:-.25px}
h3{font-size:var(--fs-l);font-weight:500}
p{margin:var(--sp-2) 0 var(--sp-4)}
a{color:var(--primary);text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
code,pre{font-family:var(--mono)}
.skip{position:absolute;left:-9999px;top:0;padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-s);background:var(--skip-bg);color:var(--skip-fg);z-index:10}
.skip:focus{left:var(--sp-3);top:var(--sp-3)}
table{width:100%;overflow:hidden;border:1px solid var(--outline-variant);border-collapse:separate;border-spacing:0;border-radius:var(--radius-m);background:var(--surface)}
caption{padding:0 0 var(--sp-3);color:var(--muted);font-size:var(--fs-s);font-weight:500;text-align:left}
thead{background:var(--surface-container)}
th,td{height:52px;padding:var(--sp-2) var(--sp-4);border:0;border-bottom:1px solid var(--outline-variant);text-align:left;vertical-align:middle}
th{color:var(--muted);font-size:var(--fs-s);font-weight:600;letter-spacing:.15px}
tbody:last-child tr:last-child>td,tbody:last-child tr:last-child>th{border-bottom:0}
tbody tr:hover>td{background:color-mix(in srgb,var(--primary) 5%,transparent)}
tbody th[scope="rowgroup"]{height:40px;background:var(--surface-container-high);color:var(--fg)}
table a{color:var(--primary);font-weight:500}
[data-tone]{display:inline-flex;align-items:center;min-height:24px;padding:1px var(--sp-2);border-radius:999px;font-size:var(--fs-s);font-weight:600;white-space:nowrap}
[data-tone="muted"]{color:var(--muted);background:var(--surface-container)}
[data-tone="ok"],.diff-add{color:var(--ok);background:var(--ok-bg)}
[data-tone="warn"],.diff-hunk{color:var(--warn);background:var(--warn-bg)}
[data-tone="danger"],.diff-del,[role="alert"]{color:var(--danger);background:var(--danger-bg)}
[role="alert"],[data-banner]{padding:var(--sp-3) var(--sp-4);border-left:4px solid currentColor;border-radius:var(--radius-s)}
form{padding:var(--sp-4);border:1px solid var(--outline-variant);border-radius:var(--radius-m);background:var(--surface-container)}
#audit-runner{display:grid;grid-template-columns:minmax(15rem,1.4fr) minmax(10rem,1fr) minmax(12rem,1fr) auto;align-items:end;gap:var(--sp-3);margin-bottom:var(--sp-5)}
#audit-runner small,#audit-runner output,#audit-runner p{grid-column:1/-1;margin:0}
.decide-form,#review-form{display:grid;gap:var(--sp-3);margin-top:var(--sp-3)}
label{display:block;color:var(--muted);font-size:var(--fs-s);font-weight:600}
button,input,select,textarea{min-height:44px;max-width:100%;padding:0 var(--sp-3);border:1px solid var(--outline);border-radius:var(--radius-s);background:var(--surface);color:var(--fg);font:inherit}
textarea{min-height:calc(44px * 2);padding:var(--sp-3);resize:vertical}
input:hover,select:hover,textarea:hover{border-color:var(--fg)}
button{border-color:var(--primary);background:var(--primary);color:var(--on-primary);font-weight:600;cursor:pointer}
button:hover{filter:brightness(.96);box-shadow:0 1px 2px rgb(60 64 67 / .25)}
button[data-v="fail"],button[data-v="reject"]{background:transparent;color:var(--danger);border-color:var(--danger)}
button[disabled]{border-color:var(--outline);background:var(--surface-container);color:var(--muted);box-shadow:none;cursor:not-allowed}
details{border:1px solid var(--outline-variant);border-radius:var(--radius-m);background:var(--surface)}
summary{min-height:44px;padding:var(--sp-3) var(--sp-4);cursor:pointer;font-weight:500}
details>pre,details>p{margin:0;border-top:1px solid var(--outline-variant)}
pre{overflow-x:auto;max-width:100%;padding:var(--sp-4);white-space:pre;background:var(--surface-container);font-size:var(--fs-s)}
.diff-add,.diff-del,.diff-hunk{display:block;padding:0 var(--sp-2)}
nav[aria-label="分页"]{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);margin-top:var(--sp-4);padding:var(--sp-3) 0 0;border-top:1px solid var(--outline-variant)}
nav[aria-label="分页"] a,nav[aria-label="分页"] span{min-height:44px;display:inline-flex;align-items:center;padding:0 var(--sp-3);border-radius:999px}
nav[aria-label="分页"] a{text-decoration:none;font-weight:600}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
@media (min-width:720px){table{display:table}}
@media (max-width:719px){
  body>header{min-height:72px;align-items:flex-start;flex-wrap:wrap;padding:var(--sp-3) var(--sp-4)}
  body>header small{width:100%;margin-left:0}
  body>nav{padding:var(--sp-1) var(--sp-2)}
  body>nav .nav-refresh{margin-left:0}
  main{margin:var(--sp-3);padding:var(--sp-4);border-radius:var(--radius-m)}
  table{display:block;overflow-x:auto}
  #audit-runner{grid-template-columns:1fr}
  #audit-runner button,.decide-form button,#review-form button{width:100%}
  nav[aria-label="分页"]{flex-wrap:wrap}
}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`
