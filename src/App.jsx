import React, { useEffect, useMemo, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { createWorker } from 'tesseract.js';
import { jsPDF } from 'jspdf';

const STORAGE = {
  residents: 'portaria_mobile_residents_v1',
  parcels: 'portaria_mobile_parcels_v1',
  memory: 'portaria_mobile_ocr_memory_v1',
};

const FIELD_LIST = [
  { id: 'resident', label: 'Nome do morador' },
  { id: 'apartment', label: 'Apartamento / bloco' },
  { id: 'carrier', label: 'Transportadora' },
  { id: 'tracking', label: 'Código / observações' },
];

const CARRIER_HINTS = [
  ['MERCADO LIVRE', 'Mercado Livre'],
  ['MERCADOLIVRE', 'Mercado Livre'],
  ['AMAZON', 'Amazon'],
  ['SHOPEE', 'Shopee'],
  ['CORREIOS', 'Correios'],
  ['MAGALU', 'Magalu Entregas'],
];

function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function emptyForm() {
  return { resident: '', apartment: '', carrier: '', tracking: '', extraDetails: [] };
}

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());
}

export default function App() {
  const [residents, setResidents] = useState(() => load(STORAGE.residents, []));
  const [parcels, setParcels] = useState(() => load(STORAGE.parcels, {}));
  const [memory, setMemory] = useState(() => load(STORAGE.memory, []));
  const [form, setForm] = useState(emptyForm);
  const [residentForm, setResidentForm] = useState({ name: '', apartment: '', phone: '', photo: '', family: [] });
  const [editingResidentId, setEditingResidentId] = useState(null);
  const [editingParcel, setEditingParcel] = useState(null);
  const [tab, setTab] = useState('desk');
  const [notice, setNotice] = useState({ text: 'Registre a encomenda manualmente ou leia a etiqueta pela câmera.', type: 'info' });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [ocrText, setOcrText] = useState('');

  useEffect(() => localStorage.setItem(STORAGE.residents, JSON.stringify(residents)), [residents]);
  useEffect(() => localStorage.setItem(STORAGE.parcels, JSON.stringify(parcels)), [parcels]);
  useEffect(() => localStorage.setItem(STORAGE.memory, JSON.stringify(memory)), [memory]);

  const today = localDateKey();
  const todayParcels = parcels[today] || [];
  const pendingParcels = useMemo(() => Object.entries(parcels)
    .flatMap(([day, items]) => (items || []).filter(item => item.status !== 'Retirado').map(item => ({ ...item, day })))
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || ''))), [parcels]);
  const filteredParcels = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return todayParcels;
    return todayParcels.filter(parcel => normalize(Object.values(parcel.data || {}).flat().join(' ')).includes(term));
  }, [todayParcels, query]);
  const filteredPending = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return pendingParcels;
    return pendingParcels.filter(parcel => normalize(`${Object.values(parcel.data || {}).flat().join(' ')} ${parcel.day}`).includes(term));
  }, [pendingParcels, query]);

  function updateField(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function applyLabelText(text) {
    const normalizedText = normalize(text);
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const suggested = emptyForm();
    const findAfter = labels => {
      for (let index = 0; index < lines.length; index += 1) {
        const normalizedLine = normalize(lines[index]);
        const label = labels.find(candidate => normalizedLine.includes(normalize(candidate)));
        if (!label) continue;
        const position = normalizedLine.indexOf(normalize(label));
        const remainder = lines[index].slice(position + label.length).replace(/^\s*[:#-]?\s*/, '').trim();
        if (remainder.length > 1) return remainder;
        if (lines[index + 1]) return lines[index + 1];
      }
      return '';
    };

    suggested.resident = findAfter(['DESTINATARIO', 'RECEBEDOR', 'CLIENTE']);
    suggested.apartment = findAfter(['APARTAMENTO', 'APTO', 'BLOCO']);
    suggested.tracking = findAfter(['PEDIDO', 'PEDIDO Nº', 'PEDIDO NO', 'OBJETO', 'RASTREAMENTO', 'RASTREIO']);
    if (!suggested.apartment) {
      const match = normalizedText.match(/(?:APTO|APT|APARTAMENTO|BLOCO)\s*[:#-]?\s*([0-9A-Z]+)/);
      if (match) suggested.apartment = `Apto ${match[1]}`;
    }
    const carrierHint = CARRIER_HINTS.find(([needle]) => normalizedText.includes(needle));
    suggested.carrier = carrierHint?.[1] || findAfter(['TRANSPORTADORA', 'REMETENTE']) || '';

    const residentMatch = residents.find(resident => resident.name && normalizedText.includes(normalize(resident.name))
      || (resident.family || []).some(relative => relative.name && normalizedText.includes(normalize(relative.name))));
    if (residentMatch) {
      const relative = (residentMatch.family || []).find(person => person.name && normalizedText.includes(normalize(person.name)));
      suggested.resident = relative ? `${relative.name} (${relative.relation || 'familiar'})` : residentMatch.name;
      suggested.apartment = residentMatch.apartment;
    }

    setForm(current => ({ ...current, ...Object.fromEntries(['resident', 'apartment', 'carrier', 'tracking'].map(key => [key, suggested[key] || current[key]])) }));
    setOcrText(text);
    setNotice({ text: 'Leitura concluída. Confira e corrija os campos antes de salvar.', type: 'success' });
  }

  async function recognizeImage(image) {
    setBusy(true);
    setNotice({ text: 'Lendo a etiqueta em português. Aguarde…', type: 'info' });
    let worker;
    try {
      worker = await createWorker('por');
      const result = await worker.recognize(image);
      applyLabelText(result.data.text || '');
    } catch (error) {
      console.error('Falha no OCR:', error);
      setNotice({ text: 'Não foi possível ler a etiqueta. Preencha os dados manualmente.', type: 'error' });
    } finally {
      if (worker) await worker.terminate().catch(() => {});
      setBusy(false);
    }
  }

  async function takePhoto() {
    try {
      const photo = await Camera.getPhoto({ quality: 85, allowEditing: false, resultType: CameraResultType.DataUrl, source: CameraSource.Camera, correctOrientation: true });
      if (photo.dataUrl) await recognizeImage(photo.dataUrl);
    } catch (error) {
      if (error?.message) setNotice({ text: 'Câmera cancelada ou sem permissão. Você também pode escolher uma foto da galeria.', type: 'error' });
    }
  }

  async function chooseImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await recognizeImage(file);
  }

  function saveParcel(event) {
    event.preventDefault();
    if (!form.resident.trim() && !form.apartment.trim()) {
      setNotice({ text: 'Informe pelo menos o nome do morador ou o apartamento.', type: 'error' });
      return;
    }
    const entry = {
      id: editingParcel?.id || newId(),
      receivedAt: editingParcel?.receivedAt || new Date().toISOString(),
      status: editingParcel?.status || 'Pendente',
      pickedUpBy: editingParcel?.pickedUpBy || '',
      leftAt: editingParcel?.leftAt || '',
      data: { ...form, extraDetails: (form.extraDetails || []).filter(detail => detail.label?.trim() || detail.value?.trim()) },
    };
    const targetDay = editingParcel?.day || today;
    setParcels(current => {
      const next = { ...current };
      const dayItems = [...(next[targetDay] || [])];
      if (editingParcel) {
        const index = dayItems.findIndex(item => item.id === editingParcel.id);
        if (index >= 0) dayItems[index] = entry;
        else dayItems.unshift(entry);
      } else dayItems.unshift(entry);
      next[targetDay] = dayItems;
      return next;
    });
    if (ocrText && form.carrier.trim()) {
      const keyword = normalize(ocrText).split(/\s+/).map(word => word.replace(/[^A-Z0-9]/g, '')).find(word => word.length >= 5);
      if (keyword && !memory.some(item => item.keyword === keyword && item.carrier === form.carrier.trim())) {
        setMemory(current => [{ keyword, carrier: form.carrier.trim() }, ...current].slice(0, 100));
      }
    }
    setEditingParcel(null);
    setForm(emptyForm());
    setOcrText('');
    setNotice({ text: 'Encomenda registrada neste celular.', type: 'success' });
  }

  function markPickedUp(parcel) {
    const pickedUpBy = window.prompt('Nome de quem retirou a encomenda:');
    if (!pickedUpBy?.trim()) return;
    setParcels(current => ({
      ...current,
      [parcel.day]: (current[parcel.day] || []).map(item => item.id === parcel.id
        ? { ...item, status: 'Retirado', pickedUpBy: pickedUpBy.trim(), leftAt: new Date().toISOString() }
        : item),
    }));
  }

  function deleteParcel(parcel) {
    if (!window.confirm('Excluir esta encomenda?')) return;
    setParcels(current => ({ ...current, [parcel.day]: (current[parcel.day] || []).filter(item => item.id !== parcel.id) }));
  }

  function addFamilyMember() {
    setResidentForm(current => ({ ...current, family: [...(current.family || []), { id: newId(), name: '', relation: '' }] }));
  }

  function updateFamilyMember(id, key, value) {
    setResidentForm(current => ({ ...current, family: (current.family || []).map(person => person.id === id ? { ...person, [key]: value } : person) }));
  }

  function saveResident(event) {
    event.preventDefault();
    if (!residentForm.name.trim() || !residentForm.apartment.trim()) return;
    const resident = { ...residentForm, id: editingResidentId || newId(), family: (residentForm.family || []).filter(person => person.name.trim()) };
    setResidents(current => editingResidentId
      ? current.map(item => item.id === editingResidentId ? resident : item)
      : [resident, ...current]);
    setResidentForm({ name: '', apartment: '', phone: '', photo: '', family: [] });
    setEditingResidentId(null);
  }

  function editResident(resident) {
    setResidentForm({ name: resident.name || '', apartment: resident.apartment || '', phone: resident.phone || '', photo: resident.photo || '', family: resident.family || [] });
    setEditingResidentId(resident.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function chooseResidentPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = reject;
        element.src = dataUrl;
      });
      const scale = Math.min(1, 600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      setResidentForm(current => ({ ...current, photo: canvas.toDataURL('image/jpeg', 0.78) }));
    } catch {
      setNotice({ text: 'Não foi possível carregar essa foto. Tente outra imagem.', type: 'error' });
    }
  }

  function deleteResident(resident) {
    if (!window.confirm(`Excluir o cadastro de ${resident.name}?`)) return;
    setResidents(current => current.filter(item => item.id !== resident.id));
  }

  function exportPdf(day) {
    const doc = new jsPDF();
    const rows = parcels[day] || [];
    doc.setFontSize(16);
    doc.text(`Relatório de encomendas - ${day}`, 14, 18);
    doc.setFontSize(10);
    let y = 30;
    rows.forEach((item, index) => {
      const received = new Date(item.receivedAt).toLocaleString('pt-BR');
      const left = item.leftAt ? new Date(item.leftAt).toLocaleString('pt-BR') : 'Ainda pendente';
      const extra = (item.data.extraDetails || []).map(detail => `${detail.label || 'Detalhe'}: ${detail.value}`).filter(Boolean).join(' | ');
      const details = FIELD_LIST.map(field => item.data[field.id] ? `${field.label}: ${item.data[field.id]}` : '').filter(Boolean).join(' | ');
      const lines = doc.splitTextToSize(`${index + 1}. ${item.status} | Recebido: ${received} | Retirada: ${left}${item.pickedUpBy ? ` por ${item.pickedUpBy}` : ''} | ${[details, extra].filter(Boolean).join(' | ')}`, 180);
      if (y + lines.length * 6 > 280) { doc.addPage(); y = 20; }
      doc.text(lines, 14, y);
      y += lines.length * 6 + 5;
    });
    doc.save(`portaria-encomendas-${day}.pdf`);
  }

  function renderParcelCard(parcel) {
    const received = parcel.receivedAt ? new Date(parcel.receivedAt).toLocaleString('pt-BR') : 'Data não informada';
    const extraDetails = parcel.data.extraDetails || [];
    return (
      <article className="list-card" key={`${parcel.day}-${parcel.id}`}>
        <div className="card-topline">
          <span className={`badge ${parcel.status === 'Retirado' ? 'badge-done' : 'badge-pending'}`}>{parcel.status || 'Pendente'}</span>
          <span className="muted">{parcel.day} · Recebido: {received}</span>
        </div>
        <h3>{parcel.data.resident || 'Morador não informado'}</h3>
        <p>{parcel.data.apartment || 'Apartamento não informado'}{parcel.data.carrier ? ` · ${parcel.data.carrier}` : ''}</p>
        {parcel.data.tracking && <p className="muted">{parcel.data.tracking}</p>}
        {extraDetails.filter(detail => detail.label || detail.value).map((detail, index) => <p className="muted" key={detail.id || index}>{detail.label || 'Detalhe'}: {detail.value}</p>)}
        {parcel.status === 'Retirado' && <p className="muted">Retirado por {parcel.pickedUpBy} · {parcel.leftAt ? new Date(parcel.leftAt).toLocaleString('pt-BR') : ''}</p>}
        <div className="button-row">
          {parcel.status !== 'Retirado' && <button className="button small green" onClick={() => markPickedUp(parcel)}>Registrar retirada</button>}
          <button className="button small secondary" onClick={() => { setEditingParcel(parcel); setForm({ ...emptyForm(), ...parcel.data, extraDetails: parcel.data.extraDetails || [] }); setTab('desk'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Editar</button>
          <button className="button small red" onClick={() => deleteParcel(parcel)}>Excluir</button>
        </div>
      </article>
    );
  }

  const reportDays = Object.keys(parcels).sort().reverse();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div><p className="eyebrow">CONTROLE DE ENTREGAS</p><h1>Portaria</h1></div>
        <button className="button header-button" onClick={() => { setTab('residents'); setEditingResidentId(null); setResidentForm({ name: '', apartment: '', phone: '', photo: '', family: [] }); }}>+ Morador</button>
      </header>
      <main className="main-content">
        {tab === 'desk' && <section>
          <div className="panel">
            <h2>{editingParcel ? 'Editar encomenda' : 'Receber encomenda'}</h2>
            <p className="help-text">Fotografe a etiqueta ou preencha os dados. Revise as sugestões do OCR antes de registrar.</p>
            <div className="capture-grid">
              <button type="button" className="button camera-button" disabled={busy} onClick={takePhoto}>{busy ? 'Lendo etiqueta…' : 'Abrir câmera'}</button>
              <label className="button gallery-button">Escolher foto<input type="file" accept="image/*" onChange={chooseImage} disabled={busy} /></label>
            </div>
            <div className={`notice ${notice.type}`} role="status">{notice.text}</div>
            <form onSubmit={saveParcel}>
              {FIELD_LIST.map(field => <label className="field-label" key={field.id}>{field.label}<input value={form[field.id] || ''} onChange={event => updateField(field.id, event.target.value)} placeholder="Confira e complete os dados" /></label>)}
              <div className="section-heading" style={{ marginTop: 16 }}><h3 style={{ margin: 0 }}>Detalhes adicionais da etiqueta</h3></div>
              {(form.extraDetails || []).map((detail, index) => <div key={detail.id || index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <label className="field-label">Detalhe<input value={detail.label || ''} onChange={event => setForm(current => ({ ...current, extraDetails: current.extraDetails.map((item, i) => i === index ? { ...item, label: event.target.value } : item) }))} placeholder="Ex.: Cor, tamanho" /></label>
                <label className="field-label">Informação<input value={detail.value || ''} onChange={event => setForm(current => ({ ...current, extraDetails: current.extraDetails.map((item, i) => i === index ? { ...item, value: event.target.value } : item) }))} placeholder="Digite o detalhe" /></label>
                <button type="button" className="button small red" aria-label="Remover detalhe" onClick={() => setForm(current => ({ ...current, extraDetails: current.extraDetails.filter((_, i) => i !== index) }))}>Remover</button>
              </div>)}
              <button type="button" className="button secondary full" onClick={() => setForm(current => ({ ...current, extraDetails: [...(current.extraDetails || []), { id: newId(), label: '', value: '' }] }))}>+ Adicionar detalhe</button>
              <button className="button green full" type="submit">{editingParcel ? 'Atualizar encomenda' : 'Registrar recebimento'}</button>
              {editingParcel && <button className="button secondary full" type="button" onClick={() => { setEditingParcel(null); setForm(emptyForm()); }}>Cancelar edição</button>}
            </form>
          </div>
          <div className="panel">
            <div className="section-heading"><h2>Encomendas de hoje</h2><span className="count-pill">{todayParcels.length}</span></div>
            <input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por morador, apto ou transportadora" />
            {filteredParcels.length ? filteredParcels.map(parcel => renderParcelCard({ ...parcel, day: today })) : <p className="empty">Nenhuma encomenda encontrada hoje.</p>}
          </div>
          <div className="panel">
            <div className="section-heading"><h2>Encomendas pendentes</h2><span className="count-pill">{pendingParcels.length}</span></div>
            <p className="help-text">Mostra encomendas ainda não retiradas, inclusive as registradas em dias anteriores.</p>
            {filteredPending.length ? filteredPending.map(renderParcelCard) : <p className="empty">Não há encomendas pendentes{query.trim() ? ' correspondentes à busca' : ''}.</p>}
          </div>
        </section>}

        {tab === 'residents' && <section>
          <div className="panel">
            <h2>{editingResidentId ? 'Editar morador' : 'Cadastrar morador'}</h2>
            <form onSubmit={saveResident}>
              <label className="field-label">Nome<input required value={residentForm.name} onChange={event => setResidentForm(current => ({ ...current, name: event.target.value }))} /></label>
              <label className="field-label">Apartamento / bloco<input required value={residentForm.apartment} onChange={event => setResidentForm(current => ({ ...current, apartment: event.target.value }))} /></label>
              <label className="field-label">Telefone (opcional)<input type="tel" value={residentForm.phone} onChange={event => setResidentForm(current => ({ ...current, phone: event.target.value }))} /></label>
              <label className="field-label">Foto do morador<input type="file" accept="image/*" onChange={chooseResidentPhoto} /></label>
              {residentForm.photo && <img src={residentForm.photo} alt="Foto do morador" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 12, marginTop: 10 }} />}
              <div className="section-heading" style={{ marginTop: 18 }}><h3 style={{ margin: 0 }}>Parentes / membros do apartamento</h3><button type="button" className="button small secondary" onClick={addFamilyMember}>+ Adicionar</button></div>
              {(residentForm.family || []).map(person => <div className="list-card" key={person.id}>
                <label className="field-label">Nome<input value={person.name || ''} onChange={event => updateFamilyMember(person.id, 'name', event.target.value)} /></label>
                <label className="field-label">Parentesco / relação<input value={person.relation || ''} onChange={event => updateFamilyMember(person.id, 'relation', event.target.value)} placeholder="Ex.: cônjuge, filho" /></label>
                <button type="button" className="button small red" onClick={() => setResidentForm(current => ({ ...current, family: current.family.filter(item => item.id !== person.id) }))}>Remover membro</button>
              </div>)}
              <button className="button green full" type="submit">{editingResidentId ? 'Salvar alterações' : 'Cadastrar morador'}</button>
              {editingResidentId && <button className="button secondary full" type="button" onClick={() => { setEditingResidentId(null); setResidentForm({ name: '', apartment: '', phone: '', photo: '', family: [] }); }}>Cancelar edição</button>}
            </form>
          </div>
          <div className="panel"><h2>Moradores cadastrados</h2>{residents.length ? residents.map(resident => <article className="list-card" key={resident.id}>
            {resident.photo && <img src={resident.photo} alt={`Foto de ${resident.name}`} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10, float: 'right', marginLeft: 10 }} />}
            <h3>{resident.name}</h3><p>{resident.apartment}{resident.phone ? ` · ${resident.phone}` : ''}</p>
            {(resident.family || []).length > 0 && <p className="muted">Membros: {resident.family.map(person => `${person.name}${person.relation ? ` (${person.relation})` : ''}`).join(', ')}</p>}
            <div className="button-row"><button className="button small secondary" onClick={() => editResident(resident)}>Editar</button><button className="button small red" onClick={() => deleteResident(resident)}>Excluir</button></div>
          </article>) : <p className="empty">Nenhum morador cadastrado.</p>}</div>
        </section>}

        {tab === 'reports' && <section className="panel"><h2>Relatórios PDF</h2><p className="help-text">Exporte uma cópia dos registros de cada dia. As encomendas pendentes também ficam listadas na tela Portaria, mesmo em dias seguintes.</p>
          {reportDays.length ? reportDays.map(day => <div className="report-row" key={day}><div><strong>{day}</strong><p className="muted">{(parcels[day] || []).length} encomenda(s)</p></div><button className="button small green" onClick={() => exportPdf(day)}>Baixar PDF</button></div>) : <p className="empty">Ainda não há relatórios.</p>}
        </section>}

        {tab === 'settings' && <section className="panel"><h2>Leitura inteligente</h2><p className="help-text">O app usa OCR em português e regras locais para sugerir nome, apartamento e transportadora. Confira os dados antes de salvar.</p>
          <h3 className="subheading">Transportadoras aprendidas</h3>
          {memory.length ? memory.slice(0, 20).map((item, index) => <div className="memory-row" key={`${item.keyword}-${index}`}><span>{item.keyword}</span><strong>{item.carrier}</strong></div>) : <p className="empty">Ainda não há sugestões aprendidas.</p>}
        </section>}
      </main>
      <nav className="bottom-nav" aria-label="Navegação principal">
        <button className={tab === 'desk' ? 'active' : ''} onClick={() => setTab('desk')}><span>⌂</span>Portaria</button>
        <button className={tab === 'residents' ? 'active' : ''} onClick={() => setTab('residents')}><span>♙</span>Moradores</button>
        <button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}><span>▤</span>Relatórios</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><span>⚙</span>IA</button>
      </nav>
    </div>
  );
}
