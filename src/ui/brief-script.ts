/**
 * S3 client-side script for /brief (urtext-20260724-ui-redesign §6.2/§3.2).
 * No imports — a single delegated listener drives the inline review form and
 * the explain control. No prompt()/alert(): decisions and explanations are
 * read from/written to in-page controls.
 */
export const BRIEF_SCRIPT = `
const csrfMeta = document.querySelector('meta[name="csrf-token"]')
const csrf = csrfMeta ? csrfMeta.content : ''
const form = document.getElementById('review-form')
if (form) {
  const msg = document.getElementById('review-msg')
  const note = document.getElementById('review-note')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const decision = e.submitter && e.submitter.dataset.v
    if (decision !== 'approve' && decision !== 'reject') return
    const trimmed = note.value.trim()
    if (decision === 'approve' && !trimmed) { msg.textContent = '批准必须填写一句理由'; return }
    try {
      const r = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: form.dataset.key, decision, briefHash: form.dataset.brief, ...(trimmed ? { note: trimmed } : {}) }),
      })
      const j = await r.json()
      if (j.error) { msg.textContent = j.error; return }
      location.href = '/'
    } catch { msg.textContent = '提交失败，请重试。' }
  })
}
const explainBtn = document.getElementById('explain-btn')
const explainHost = document.querySelector('[data-explain-key]')
if (explainBtn instanceof HTMLButtonElement && explainHost instanceof HTMLElement) {
  const explainAuditor = document.getElementById('explain-auditor')
  const explainModel = document.getElementById('explain-model')
  const explainOut = document.getElementById('explain-out')
  const defaultModel = { omp: 'deepseek/deepseek-v4-flash', claude: 'sonnet', codex: 'gpt-5.6-terra', traex: 'kimi-k2.6' }
  explainAuditor?.addEventListener('change', () => {
    if (explainAuditor instanceof HTMLSelectElement && explainModel instanceof HTMLInputElement) {
      explainModel.value = defaultModel[explainAuditor.value] || ''
    }
  })
  explainBtn.addEventListener('click', async () => {
    if (!(explainAuditor instanceof HTMLSelectElement) || !(explainModel instanceof HTMLInputElement) || !(explainOut instanceof HTMLOutputElement)) return
    const key = explainHost.dataset.explainKey
    if (key === undefined || key === '') return
    explainBtn.disabled = true
    explainOut.textContent = '正在生成基于当前事实投影的说明…'
    try {
      const r = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key, auditor: explainAuditor.value, ...(explainModel.value ? { model: explainModel.value } : {}) }),
      })
      const j = await r.json()
      explainOut.textContent = j.error ? j.error : j.text
    } catch {
      explainOut.textContent = '生成失败，请重试或换一个客户端。'
    } finally {
      explainBtn.disabled = false
    }
  })
}
`
