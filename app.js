const KEYS = { residents: 'portaria_residents', parcels: 'portaria_parcels', fieldConfig: 'portaria_fields', aiMemory: 'portaria_ai_memory' };
const DEFAULT_FIELDS = [
  { id: 'resident', title: 'Nome do morador', keyword: 'DESTINAT' },
  { id: 'apartment', title: 'Apartamento / bloco', keyword: 'APTO' },
  { id: 'carrier', title: 'Transportadora', keyword: 'TRANSPORTADORA' },
  { id: 'notes', title: 'Observações', keyword: 'PEDIDO' }
];
const DEFAULT_MEMORY = [
  { word: 'MERCADO LIVRE', field: 'carrier', value: 'Mercado Livre' },
  { word: 'AMAZON', field: 'carrier', value: 'Amazon' },
  { word: 'SHOPEE', field: 'carrier', value: 'Shopee' },
  { word: 'CORREIOS', field: 'carrier', value: 'Correios' }
];

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
const state = {
  residents: read(KEYS.residents, []),
  parcels: read(KEYS.parcels, {}),
  fields: read(KEYS.fieldConfig, DEFAULT_FIELDS),
  memory: read(KEYS.aiMemory, DEFAULT_MEMORY),
  ocrText: '', residentPhoto: '', family: [], editingParcel: null
};
function persist(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function dayKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function clock() { return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function status(message, kind = 'info') { const el = document.getElementById('ocr-status'); el.className = `notice ${kind}`; el.textContent = message; }
function currentDayParcels() { return state.parcels[dayKey()] || []; }
function goTo(tab) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('shown'));
  document.querySelectorAll('.navigation button').forEach(el => el.classList.remove('selected'));
  document.getElementById(`screen-${tab}`)?.classList.add('shown');
  document.getElementById(`nav-${tab}`)?.classList.add('selected');
  render();
}
function renderForm() {
  const root = document.getElementById('parcel-fields'); root.replaceChildren();
  state.fields.forEach(field => {
    const label = document.createElement('label'); label.textContent = field.title;
    const input = document.createElement('input'); input.type = 'text'; input.id = `field-${field.id}`; input.placeholder = 'Confira e complete os dados';
    root.append(label, input);
  });
}
function renderParcels() {
  const root = document.getElementById('parcel-list'); root.replaceChildren();
  const list = currentDayParcels();
  if (!list.length) { root.innerHTML = '<p class="empty">Nenhuma encomenda recebida hoje.</p>'; return; }
  list.forEach((parcel, index) => {
    const card = document.createElement('article'); card.className = 'entry';
    const badge = document.createElement('span'); badge.className = `badge ${parcel.status === 'Retirado' ? 'badge-done' : 'badge-wait'}`; badge.textContent = parcel.status;
    const details = document.createElement('div'); details.className = 'details';
    Object.entries(parcel.data).forEach(([key, value]) => { if (value) { const row = document.createElement('p'); const b = document.createElement('strong'); b.textContent = `${key}: `; row.append(b, document.createTextNode(value)); details.append(row); } });
    const time = document.createElement('p'); time.textContent = `Recebido: ${parcel.receivedAt}${parcel.leftAt ? ` • Retirado: ${parcel.leftAt} por ${parcel.pickedUpBy}` : ''}`; details.append(time);
    card.append(badge, details);
    if (parcel.status !== 'Retirado') {
      const take = button('Registrar retirada', 'button small green', () => {
        const person = prompt('Nome de quem retirou a encomenda:'); if (!person?.trim()) return;
        parcel.status = 'Retirado'; parcel.pickedUpBy = person.trim(); parcel.leftAt = clock(); persist(KEYS.parcels, state.parcels); render();
      }); card.append(take);
    }
    card.append(button('Editar', 'button small amber', () => {
      state.editingParcel = index;
      state.fields.forEach(f => { const input = document.getElementById(`field-${f.id}`); if (input) input.value = parcel.data[f.title] || ''; });
      document.getElementById('save-parcel').textContent = 'Atualizar encomenda'; goTo('desk'); window.scrollTo(0,0);
    }));
    card.append(button('Excluir', 'button small red', () => {
      if (!confirm('Excluir esta encomenda?')) return;
      state.parcels[dayKey()].splice(index, 1); persist(KEYS.parcels, state.parcels); render();
    }));
    root.append(card);
  });
}
function button(text, className, handler) { const el = document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = text; el.addEventListener('click', handler); return el; }
function renderResidents() {
  const root = document.getElementById('resident-list'); root.replaceChildren();
  if (!state.residents.length) { root.innerHTML = '<p class="empty">Cadastre moradores para agilizar a identificação.</p>'; return; }
  state.residents.forEach((resident, index) => {
    const card = document.createElement('article'); card.className = 'entry';
    const title = document.createElement('strong'); title.textContent = `${resident.apartment} — ${resident.name}`;
    const meta = document.createElement('p'); meta.className = 'details'; meta.textContent = `WhatsApp: ${resident.phone || '—'} • Familiares: ${(resident.family || []).length}`;
    card.append(title, meta, button('Editar', 'button small amber', () => editResident(index)), button('Excluir', 'button small red', () => {
      if (!confirm('Excluir o cadastro deste morador?')) return; state.residents.splice(index, 1); persist(KEYS.residents, state.residents); render();
    })); root.append(card);
  });
}
function editResident(index) {
  const resident = state.residents[index]; document.getElementById('resident-index').value = index;
  document.getElementById('resident-name').value = resident.name; document.getElementById('resident-apartment').value = resident.apartment;
  document.getElementById('resident-phone').value = resident.phone || ''; state.residentPhoto = resident.photo || ''; state.family = structuredClone(resident.family || []);
  const preview = document.getElementById('resident-preview'); preview.src = state.residentPhoto; preview.hidden = !state.residentPhoto;
  renderFamily(); document.getElementById('resident-form-title').textContent = 'Editar morador'; goTo('residents');
}
function renderFamily() {
  const root = document.getElementById('family-list'); root.replaceChildren();
  state.family.forEach((person, i) => {
    const card = document.createElement('div'); card.className = 'entry';
    const nameLabel = document.createElement('label'); nameLabel.textContent = `Nome do familiar ${i+1}`;
    const name = document.createElement('input'); name.value = person.name || ''; name.addEventListener('input', () => state.family[i].name = name.value);
    const relationLabel = document.createElement('label'); relationLabel.textContent = 'Parentesco';
    const relation = document.createElement('input'); relation.value = person.relation || ''; relation.addEventListener('input', () => state.family[i].relation = relation.value);
    card.append(nameLabel, name, relationLabel, relation); root.append(card);
  });
}
function renderSettings() {
  const fields = document.getElementById('field-settings'); fields.replaceChildren();
  state.fields.forEach((field, i) => {
    const row = document.createElement('div'); row.className = 'entry'; row.textContent = `${field.title} • chave OCR: ${field.keyword || 'nenhuma'}`;
    if (i >= DEFAULT_FIELDS.length) row.append(button('Remover', 'button small red', () => { state.fields.splice(i,1); persist(KEYS.fieldConfig,state.fields); render(); })); fields.append(row);
  });
  const memory = document.getElementById('ai-memory'); memory.replaceChildren();
  state.memory.slice(0, 40).forEach(rule => { const row = document.createElement('div'); row.className = 'entry'; row.textContent = `${rule.word} → ${rule.value}`; memory.append(row); });
}
function renderReports() {
  const root = document.getElementById('report-list'); root.replaceChildren();
  const days = Object.keys(state.parcels).sort().reverse();
  if (!days.length) { root.innerHTML = '<p class="empty">Ainda não há relatórios.</p>'; return; }
  days.forEach(day => { const card = document.createElement('article'); card.className = 'entry'; card.append(document.createTextNode(`${day}: ${(state.parcels[day] || []).length} encomenda(s) `), button('Baixar PDF', 'button small green', () => exportPdf(day))); root.append(card); });
}
function render() { renderForm(); renderParcels(); renderResidents(); renderSettings(); renderReports(); }
function parseOcr(text) {
  const lines = text.split(/\r?\n/); const upper = text.toLocaleUpperCase('pt-BR');
  state.fields.forEach(field => { const input = document.getElementById(`field-${field.id}`); if (input) input.value = ''; });
  state.memory.forEach(rule => { if (upper.includes(rule.word.toLocaleUpperCase('pt-BR'))) { const input = document.getElementById(`field-${rule.field}`); if (input && !input.value) input.value = rule.value; } });
  state.fields.forEach(field => {
    const input = document.getElementById(`field-${field.id}`); if (!input || input.value || !field.keyword) return;
    const i = lines.findIndex(line => line.toLocaleUpperCase('pt-BR').includes(field.keyword.toLocaleUpperCase('pt-BR'))); if (i < 0) return;
    const line = lines[i]; const pos = line.toLocaleUpperCase('pt-BR').indexOf(field.keyword.toLocaleUpperCase('pt-BR'));
    const value = line.slice(pos + field.keyword.length).replace(/^[:\s-]+/, '').trim(); input.value = value || (lines[i+1] || '').trim();
  });
  const apto = document.getElementById('field-apartment');
  if (apto && !apto.value) { const match = upper.match(/(?:APTO|APT|APARTAMENTO|BLOCO)\s*[:#-]?\s*([0-9A-Z]+)/); if (match) apto.value = `Apto ${match[1]}`; }
  const found = state.residents.find(r => (r.name && upper.includes(r.name.toLocaleUpperCase('pt-BR'))) || (r.family || []).some(f => f.name && upper.includes(f.name.toLocaleUpperCase('pt-BR'))));
  if (found) {
    const relative = (found.family || []).find(f => f.name && upper.includes(f.name.toLocaleUpperCase('pt-BR')));
    const residentField = document.getElementById('field-resident'); const apartmentField = document.getElementById('field-apartment');
    if (residentField) residentField.value = relative ? `${relative.name} (${relative.relation || 'familiar'})` : found.name;
    if (apartmentField) apartmentField.value = found.apartment;
    const match = document.getElementById('resident-match'); match.hidden = false; match.textContent = `Cadastro encontrado: ${found.apartment} — ${found.name}`;
  } else document.getElementById('resident-match').hidden = true;
}
async function processImage(image) {
  status('Lendo etiqueta com OCR. Aguarde…');
  if (!window.Tesseract) { status('Biblioteca OCR não carregou. Verifique a conexão ou preencha manualmente.', 'error'); return; }
  try { const result = await Tesseract.recognize(image, 'por'); state.ocrText = result.data.text || ''; parseOcr(state.ocrText); status('Leitura concluída. Confira os dados antes de salvar.', 'success'); }
  catch (error) { console.error(error); status('Falha ao ler a imagem. Tente outra foto ou preencha manualmente.', 'error'); }
}
function saveParcel() {
  const data = {}; state.fields.forEach(field => { data[field.title] = document.getElementById(`field-${field.id}`)?.value.trim() || ''; });
  if (!data[state.fields.find(f => f.id === 'resident')?.title] && !data[state.fields.find(f => f.id === 'apartment')?.title]) { status('Informe ao menos o morador ou apartamento.', 'error'); return; }
  const day = dayKey(); state.parcels[day] ||= [];
  if (state.editingParcel !== null) { state.parcels[day][state.editingParcel].data = data; state.editingParcel = null; document.getElementById('save-parcel').textContent = 'Registrar recebimento'; }
  else state.parcels[day].unshift({ receivedAt: clock(), leftAt: '', pickedUpBy: '', status: 'Pendente', data });
  if (state.ocrText && data['Transportadora']) {
    const word = state.ocrText.toUpperCase().split(/\s+/).map(s => s.replace(/[^A-Z0-9]/g, '')).find(s => s.length >= 5);
    if (word && !state.memory.some(rule => rule.word === word && rule.value === data['Transportadora'])) state.memory.unshift({ word, field: 'carrier', value: data['Transportadora'] });
  }
  persist(KEYS.parcels, state.parcels); persist(KEYS.aiMemory, state.memory); state.ocrText = '';
  document.getElementById('resident-match').hidden = true; status('Encomenda registrada com sucesso.', 'success'); render();
}
function exportPdf(day) {
  if (!window.jspdf) { alert('Não foi possível carregar a biblioteca de PDF. Verifique a conexão.'); return; }
  const doc = new window.jspdf.jsPDF(); doc.setFontSize(15); doc.text(`Relatório de encomendas — ${day}`, 14, 18); doc.setFontSize(10);
  let y = 30; (state.parcels[day] || []).forEach((parcel, i) => {
    const details = Object.entries(parcel.data).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(' | ');
    const text = doc.splitTextToSize(`${i+1}. ${parcel.status} | Entrada: ${parcel.receivedAt}${parcel.leftAt ? ` | Saída: ${parcel.leftAt} (${parcel.pickedUpBy})` : ''} | ${details}`, 180);
    if (y + text.length * 6 > 280) { doc.addPage(); y = 20; } doc.text(text, 14, y); y += text.length * 6 + 4;
  }); doc.save(`encomendas-${day}.pdf`);
}
function saveResident() {
  const name = document.getElementById('resident-name').value.trim(); const apartment = document.getElementById('resident-apartment').value.trim();
  const phone = document.getElementById('resident-phone').value.trim(); const index = Number.parseInt(document.getElementById('resident-index').value,10);
  if (!name || !apartment) { alert('Informe o nome e o apartamento.'); return; }
  const resident = { name, apartment, phone, photo: state.residentPhoto, family: state.family };
  if (index >= 0) state.residents[index] = resident; else state.residents.unshift(resident);
  persist(KEYS.residents,state.residents); document.getElementById('resident-index').value = '-1';
  document.getElementById('resident-form-title').textContent = 'Cadastrar morador'; document.getElementById('resident-name').value = ''; document.getElementById('resident-apartment').value = ''; document.getElementById('resident-phone').value = '';
  document.getElementById('resident-preview').hidden = true; state.residentPhoto = ''; state.family = []; renderFamily(); render(); alert('Cadastro salvo.');
}
function bindEvents() {
  document.getElementById('nav-desk').addEventListener('click', () => goTo('desk'));
  document.getElementById('nav-residents').addEventListener('click', () => goTo('residents'));
  document.getElementById('nav-settings').addEventListener('click', () => goTo('settings'));
  document.getElementById('nav-reports').addEventListener('click', () => goTo('reports'));
  document.getElementById('open-residents').addEventListener('click', () => goTo('residents'));
  document.getElementById('save-parcel').addEventListener('click', saveParcel);
  document.getElementById('save-resident').addEventListener('click', saveResident);
  document.getElementById('add-field').addEventListener('click', () => {
    const title = document.getElementById('new-field-title').value.trim(); const keyword = document.getElementById('new-field-keyword').value.trim();
    if (!title) { alert('Informe o nome do campo.'); return; } state.fields.push({ id: `custom-${Date.now()}`, title, keyword }); persist(KEYS.fieldConfig,state.fields); document.getElementById('new-field-title').value=''; document.getElementById('new-field-keyword').value=''; render();
  });
  document.getElementById('add-family').addEventListener('click', () => { state.family.push({name:'',relation:''}); renderFamily(); });
  document.getElementById('open-camera').addEventListener('click', async () => {
    const camera = window.Capacitor?.Plugins?.Camera; if (!camera) { document.getElementById('label-photo').click(); return; }
    try { const photo = await camera.getPhoto({ quality: 85, resultType: 'dataUrl', source: 'CAMERA' }); if (photo?.dataUrl) await processImage(photo.dataUrl); } catch { alert('Câmera cancelada ou sem permissão.'); }
  });
  document.getElementById('label-photo').addEventListener('change', event => { const file=event.target.files?.[0]; if(file) processImage(file); event.target.value=''; });
  document.getElementById('resident-photo').addEventListener('change', event => {
    const file=event.target.files?.[0]; if(!file) return; const reader=new FileReader(); reader.onload=()=>{ const img=new Image(); img.onload=()=>{ const canvas=document.createElement('canvas'); const scale=Math.min(1,140/Math.max(img.width,img.height)); canvas.width=Math.max(1,img.width*scale); canvas.height=Math.max(1,img.height*scale); canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height); state.residentPhoto=canvas.toDataURL('image/jpeg',.7); const preview=document.getElementById('resident-preview'); preview.src=state.residentPhoto; preview.hidden=false; }; img.src=reader.result; }; reader.readAsDataURL(file);
  });
}
window.addEventListener('DOMContentLoaded', () => { bindEvents(); render(); });
