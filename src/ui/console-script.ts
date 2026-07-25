/**
 * S2 console client script (urtext-20260724-ui-redesign §3.1/§5.1). Delegated
 * listeners only — no inline handlers, no `prompt()`/`alert()`. Decisions and
 * audit runs post with the session CSRF token and write results inline via
 * `aria-live` outputs.
 */
export const CONSOLE_SCRIPT = `<script>
const csrf = document.querySelector('meta[name=csrf-token]').content
document.addEventListener('submit', async (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('decide-form')) return
  e.preventDefault()
  const output = form.parentElement ? form.parentElement.querySelector('.decision-msg') : null
  const submitter = e.submitter
  const verdict = submitter && submitter.dataset ? submitter.dataset.v : undefined
  const noteField = form.querySelector('textarea[name=note]')
  const note = noteField ? noteField.value.trim() : ''
  if (verdict === 'pass' && !note) {
    if (output) output.textContent = 'a one-sentence reason is required to pass'
    return
  }
  const key = form.dataset.key
  const cut = key.lastIndexOf('#')
  const qs = 'spec=' + encodeURIComponent(key.slice(0, cut)) + '&clause=' + encodeURIComponent(key.slice(cut + 1))
  try {
    const br = await fetch('/api/brief?' + qs)
    const bj = await br.json()
    if (bj.error) { if (output) output.textContent = bj.error; return }
    const r = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key, verdict, briefHash: bj.briefHash, ...(note ? { note } : {}) }),
    })
    const j = await r.json()
    if (j.error) { if (output) output.textContent = j.error; return }
    location.reload()
  } catch {
    if (output) output.textContent = 'request failed; the clause was not decided'
  }
})
document.getElementById('audit-runner')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.currentTarget
  const button = form.querySelector('button')
  const progress = document.getElementById('audit-progress')
  button.disabled = true
  progress.textContent = 'Running audit; large batches on slow models can take many minutes…'
  const fields = new FormData(form)
  try {
    const r = await fetch('/api/audit-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ auditor: fields.get('auditor'), model: fields.get('model'), profile: fields.get('profile') }),
    })
    const j = await r.json()
    if (j.error) { progress.textContent = j.error; button.disabled = false; return }
    progress.textContent = j.message + ' Refreshing queue…'
    location.href = '/?audit=' + encodeURIComponent(j.message)
  } catch {
    progress.textContent = 'Audit request failed; no verdicts were imported.'
    button.disabled = false
  }
})
</script>`
