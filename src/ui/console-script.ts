/**
 * S2 console client script (urtext-20260724-ui-redesign §3.1/§5.1). Delegated
 * listeners only — no inline handlers, no `prompt()`/`alert()`. Decisions and
 * audit runs post with the session CSRF token and write results inline via
 * `aria-live` outputs.
 */
export const CONSOLE_SCRIPT = `<script>
const csrfMeta = document.querySelector('meta[name="csrf-token"]')
const csrf = csrfMeta instanceof HTMLMetaElement ? csrfMeta.content : ''
document.addEventListener('submit', async (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement) || !form.classList.contains('decide-form')) return
  e.preventDefault()
  const output = form.parentElement?.querySelector('.decision-msg')
  const submitter = e.submitter
  const verdict = submitter instanceof HTMLElement ? submitter.dataset.v : undefined
  const noteField = form.querySelector('textarea[name=note]')
  const note = noteField instanceof HTMLTextAreaElement ? noteField.value.trim() : ''
  if (verdict === 'pass' && !note) {
    if (output instanceof HTMLOutputElement) output.textContent = 'a one-sentence reason is required to pass'
    return
  }
  if (verdict !== 'pass' && verdict !== 'fail') return
  const key = form.dataset.key
  if (key === undefined || key === '') return
  const cut = key.lastIndexOf('#')
  if (cut <= 0) return
  const qs = 'spec=' + encodeURIComponent(key.slice(0, cut)) + '&clause=' + encodeURIComponent(key.slice(cut + 1))
  try {
    const br = await fetch('/api/brief?' + qs)
    const bj = await br.json()
    if (bj.error) { if (output instanceof HTMLOutputElement) output.textContent = bj.error; return }
    const r = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key, verdict, briefHash: bj.briefHash, ...(note ? { note } : {}) }),
    })
    const j = await r.json()
    if (j.error) { if (output instanceof HTMLOutputElement) output.textContent = j.error; return }
    location.reload()
  } catch {
    if (output instanceof HTMLOutputElement) output.textContent = 'request failed; the clause was not decided'
  }
})
const auditRunner = document.getElementById('audit-runner')
auditRunner?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.currentTarget
  if (!(form instanceof HTMLFormElement)) return
  const button = form.querySelector('button')
  const progress = document.getElementById('audit-progress')
  if (!(button instanceof HTMLButtonElement) || !(progress instanceof HTMLOutputElement)) return
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
    location.href = '/agent?audit=' + encodeURIComponent(j.message)
  } catch {
    progress.textContent = 'Audit request failed; no verdicts were imported.'
    button.disabled = false
  }
})
const queueExplainAuditor = document.getElementById('queue-explain-auditor')
const queueExplainModel = document.getElementById('queue-explain-model')
const explainDefaults = { omp: 'deepseek/deepseek-v4-flash', claude: 'sonnet', codex: 'gpt-5.6-terra', traex: 'kimi-k2.6' }
queueExplainAuditor?.addEventListener('change', () => {
  if (queueExplainAuditor instanceof HTMLSelectElement && queueExplainModel instanceof HTMLInputElement) {
    queueExplainModel.value = explainDefaults[queueExplainAuditor.value] || ''
  }
})
const explainPicker = () => ({
  auditor: queueExplainAuditor instanceof HTMLSelectElement ? queueExplainAuditor.value : 'omp',
  model: queueExplainModel instanceof HTMLInputElement ? queueExplainModel.value : '',
})
const runExplain = async (button, output, payload) => {
  if (!(button instanceof HTMLButtonElement) || !(output instanceof HTMLOutputElement)) return
  button.disabled = true
  output.textContent = '正在生成基于当前事实投影的说明…'
  const picker = explainPicker()
  try {
    const response = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ ...payload, auditor: picker.auditor, ...(picker.model ? { model: picker.model } : {}) }),
    })
    const result = await response.json()
    output.textContent = result.error ? result.error : result.text
  } catch {
    output.textContent = '生成失败；没有写入任何裁决。'
  } finally {
    button.disabled = false
  }
}
const outputFor = (button) => {
  const id = button.getAttribute('aria-controls')
  const output = id === null ? null : document.getElementById(id)
  return output instanceof HTMLOutputElement ? output : null
}
document.addEventListener('click', (event) => {
  const target = event.target
  const button = target instanceof Element ? target.closest('button[data-explain-key]') : null
  if (!(button instanceof HTMLButtonElement)) return
  const key = button.dataset.explainKey
  const output = outputFor(button)
  if (key === undefined || key === '' || output === null) return
  void runExplain(button, output, { key })
})
document.getElementById('queue-explain-btn')?.addEventListener('click', (event) => {
  const button = event.currentTarget
  const output = button instanceof HTMLButtonElement ? outputFor(button) : null
  if (button instanceof HTMLButtonElement && output !== null) void runExplain(button, output, { scope: 'queue' })
})
</script>`
