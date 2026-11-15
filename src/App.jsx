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
  return { resident: '', apartment: '', carrier: '', tracking: '', additionalDetails: [] };
}

function emptyResidentForm() {
  return { name: '', apartment: '', phone: '', photo: '', family: [] };
}

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function createFamilyMember() {
  return { id: createId(), name: '', relation: '', photo: '' };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl, maxWidth = 640) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, maxWidth / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    image.onerror = () => reject(new Error('Não foi possível processar a imagem.'));
    image.src = dataUrl;
  });
}

export default function App() {
  const [residents, setResidents] = useState(() => load(STORAGE.residents, []));
  const [parcels, setParcels] = useState(() => load(STORAGE.parcels, {}));
  const [memory, setMemory] = useState(() => load(STORAGE.memory, []));
  const [form, setForm] = useState(emptyForm);
  const [residentForm, setResidentForm] = useState(emptyResidentForm);
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
  const filteredParcels = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return todayParcels;
    return todayParcels.filter(parcel => {
      const combined = [
        ...Object.values(parcel.data || {}).filter(value => typeof value === 'string' || Array.isArray(value)),
        ((parcel.data?.additionalDetails || []).map(item => `${item.label || ''} ${item.value || ''}`)).join(' '),
      ].join(' ');
      return normalize(combined).includes(term);
    });
  }, [todayParcels, query]);

  function updateField(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function addFamilyMember() {
    setResidentForm(current => ({ ...current, family: [...current.family, createFamilyMember()] }));
  }

  function removeFamilyMember(index) {
    setResidentForm(current => ({ ...current, family: current.family.filter((_, i) => i !== index) }));
  }

  function updateFamilyMember(index, field, value) {
    setResidentForm(current => ({
      ...current,
      family: current.family.map((member, i) => i === index ? { ...member, [field]: value } : member),
    }));
  }

  async function handleResidentPhotoChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImage(await readFileAsDataUrl(file));
      setResidentForm(current => ({ ...current, photo: compressed }));
    } catch (error) {
      console.error('Erro ao carregar foto do morador:', error);
      setNotice({ text: 'Não foi possível carregar a foto do morador.', type: 'error' });
    }
  }

  async function handleFamilyPhotoChange(event, index) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImage(await readFileAsDataUrl(file));
      updateFamilyMember(index, 'photo', compressed);
    } catch (error) {
      console.error('Erro ao carregar foto do familiar:', error);
      setNotice({ text: 'Não foi possível carregar a foto do familiar.', type: 'error' });
    }
  }

  function findResidentMatch(text) {
    const normalizedText = normalize(text || '');
    return residents.find(resident => {
      const residentName = resident.name ? normalize(resident.name) : '';
      const relativeNames = (resident.family || []).map(member => normalize(member.name || ''));
      return residentName && normalizedText.includes(residentName) || relativeNames.some(name => name && normalizedText.includes(name));
    }) || null;
  }

  function applyLabelText(text) {
    const normalizedText = normalize(text);
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const suggested = emptyForm();

    const findAfter = (labels) => {
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

    suggested.resident = findAfter(['DESTINATARIO', 'DESTINATÁRÍO', 'RECEBEDOR', 'CLIENTE']);
    suggested.apartment = findAfter(['APARTAMENTO', 'APTO', 'BLOCO']);
    suggested.tracking = findAfter(['PEDIDO', 'PEDIDO Nº', 'PEDIDO NO', 'OBJETO', 'RASTREAMENTO', 'RASTREIO']);

    if (!suggested.apartment) {
      const match = normalizedText.match(/(?:APTO|APT|APARTAMENTO|BLOCO)\s*[:#-]?\s*([0-9A-Z]+)/);
      if (match) suggested.apartment = `Apto ${match[1]}`;
    }

    const carrierHint = CARRIER_HINTS.find(([needle]) => normalizedText.includes(needle));
    suggested.carrier = carrierHint?.[1] || findAfter(['TRANSPORTADORA', 'REMETENTE']) || '';

    const residentMatch = findResidentMatch(text);
    if (residentMatch) {
      const relative = (residentMatch.family || []).find(person => person.name && normalizedText.includes(normalize(person.name)));
      suggested.resident = relative ? `${relative.name} (${relative.relation || 'familiar'})` : residentMatch.name;
      suggested.apartment = residentMatch.apartment;
    }

    setForm(current => ({
      ...current,
      resident: suggested.resident || current.resident,
      apartment: suggested.apartment || current.apartment,
      carrier: suggested.carrier || current.carrier,
      tracking: suggested.tracking || current.tracking,
    }));
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
      const photo = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        correctOrientation: true,
      });
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
      id: editingParcel?.id || createId(),
      receivedAt: editingParcel?.receivedAt || new Date().toISOString(),
      status: editingParcel?.status || 'Pendente',
      pickedUpBy: editingParcel?.pickedUpBy || '',
      leftAt: editingParcel?.leftAt || '',
      data: { ...form },
    };

    setParcels(current => {
      const dayItems = [...(current[today] || [])];
      if (editingParcel) {
        const index = dayItems.findIndex(item => item.id === editingParcel.id);
        if (index >= 0) dayItems[index] = entry;
        else dayItems.unshift(entry);
      } else dayItems.unshift(entry);
      return { ...current, [today]: dayItems };
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
      [today]: (current[today] || []).map(item => item.id === parcel.id
        ? { ...item, status: 'Retirado', pickedUpBy: pickedUpBy.trim(), leftAt: new Date().toISOString() }
        : item),
    }));
  }

  function deleteParcel(parcel) {
    if (!window.confirm('Excluir esta encomenda?')) return;
    setParcels(current => ({ ...current, [today]: (current[today] || []).filter(item => item.id !== parcel.id) }));
  }

  function saveResident(event) {
    event.preventDefault();
    if (!residentForm.name.trim() || !residentForm.apartment.trim()) return;

    const cleanFamily = (residentForm.family || [])
      .map(member => ({
        id: member.id || createId(),
        name: (member.name || '').trim(),
        relation: (member.relation || '').trim(),
        photo: member.photo || '',
      }))
      .filter(member => member.name || member.relation || member.photo);

    const resident = {
      id: editingResidentId || createId(),
      name: residentForm.name.trim(),
      apartment: residentForm.apartment.trim(),
      phone: residentForm.phone.trim(),
      photo: residentForm.photo || '',
      family: cleanFamily,
    };

    setResidents(current => editingResidentId
      ? current.map(item => item.id === editingResidentId ? { ...item, ...resident } : item)
      : [resident, ...current]);

    setResidentForm(emptyResidentForm());
    setEditingResidentId(null);
  }

  function editResident(resident) {
    setResidentForm({
      name: resident.name,
      apartment: resident.apartment,
      phone: resident.phone || '',
      photo: resident.photo || '',
      family: (resident.family || []).map(member => ({
        id: member.id || createId(),
        name: member.name || '',
        relation: member.relation || '',
        photo: member.photo || '',
      })),
    });
    setEditingResidentId(resident.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      const details = [
        ...FIELD_LIST.map(field => item.data[field.id] ? `${field.label}: ${item.data[field.id]}` : '').filter(Boolean),
        ...(item.data.additionalDetails || []).map(detail => `${detail.label || 'Detalhe'}: ${detail.value || ''}`).filter(Boolean),
      ].join(' | ');
      const lines = doc.splitTextToSize(`${index + 1}. ${item.status} | Recebido: ${received} | Retirada: ${left}${item.pickedUpBy ? ` por ${item.pickedUpBy}` : ''} | ${details}`, 180);
      if (y + lines.length * 6 > 280) { doc.addPage(); y = 20; }
      doc.text(lines, 14, y);
      y += lines.length * 6 + 5;
    });
    doc.save(`portaria-encomendas-${day}.pdf`);
  }

  function renderParcelCard(parcel) {
    const received = new Date(parcel.receivedAt).toLocaleString('pt-BR');
    return (
      <article className="list-card" key={parcel.id}>
        <div className="card-topline">
          <span className={`badge ${parcel.status === 'Retirado' ? 'badge-done' : 'badge-pending'}`}>{parcel.status}</span>
          <span className="muted">Recebido: {received}</span>
        </div>
        <h3>{parcel.data.resident || 'Morador não informado'}</h3>
        <p>{parcel.data.apartment || 'Apartamento não informado'}{parcel.data.carrier ? ` · ${parcel.data.carrier}` : ''}</p>
        {parcel.data.tracking && <p className="muted">{parcel.data.tracking}</p>}
        {(parcel.data.additionalDetails || []).map(detail => (
          <p className="muted" key={detail.id || detail.label}>{detail.label ? `${detail.label}: ` : ''}{detail.value}</p>
        ))}
        {parcel.status === 'Retirado' && <p className="muted">Retirado por {parcel.pickedUpBy} · {new Date(parcel.leftAt).toLocaleString('pt-BR')}</p>}
        <div className="button-row">
          {parcel.status !== 'Retirado' && <button className="button small green" onClick={() => markPickedUp(parcel)}>Registrar retirada</button>}
          <button className="button small secondary" onClick={() => { setEditingParcel(parcel); setForm({ ...emptyForm(), ...parcel.data, additionalDetails: parcel.data.additionalDetails || [] }); setTab('desk'); }}>Editar</button>
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
        <button className="button header-button" onClick={() => setTab('residents')}>+ Morador</button>
      </header>

      <main className="main-content">
        {tab === 'desk' && <section>
          <div className="panel">
            <h2>Receber encomenda</h2>
            <p className="help-text">Fotografe a etiqueta ou preencha os dados. Revise as sugestões do OCR antes de registrar.</p>
            <div className="capture-grid">
              <button className="button camera-button" disabled={busy} onClick={takePhoto}>{busy ? 'Lendo etiqueta…' : 'Abrir câmera'}</button>
              <label className="button gallery-button">Escolher foto<input type="file" accept="image/*" onChange={chooseImage} disabled={busy} /></label>
            </div>
            <div className={`notice ${notice.type}`} role="status">{notice.text}</div>
            <form onSubmit={saveParcel}>
              {FIELD_LIST.map(field => (
                <label className="field-label" key={field.id}>
                  {field.label}
                  <input value={form[field.id] || ''} onChange={event => updateField(field.id, event.target.value)} placeholder={field.label} />
                </label>
              ))}

              <button type="button" className="button secondary full" onClick={() => setForm(current => ({
                ...current,
                additionalDetails: current.additionalDetails?.length ? current.additionalDetails : [ { id: createId(), label: '', value: '' } ],
              }))}>
                + Adicionar mais detalhes
              </button>

              {(form.additionalDetails || []).length > 0 && (
                <div className="extra-details-panel">
                  {(form.additionalDetails || []).map((detail, index) => (
                    <div className="extra-detail-row" key={detail.id || index}>
                      <label className="field-label">Detalhe<input value={detail.label || ''} onChange={event => setForm(current => ({
                        ...current,
                        additionalDetails: (current.additionalDetails || []).map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item),
                      }))} placeholder="Ex.: Tipo da encomenda" /></label>
                      <label className="field-label">Informação<input value={detail.value || ''} onChange={event => setForm(current => ({
                        ...current,
                        additionalDetails: (current.additionalDetails || []).map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item),
                      }))} placeholder="Ex.: Caixa grande" /></label>
                      <button type="button" className="button small red" onClick={() => setForm(current => ({
                        ...current,
                        additionalDetails: (current.additionalDetails || []).filter((_, itemIndex) => itemIndex !== index),
                      }))}>Remover</button>
                    </div>
                  ))}

                  <button type="button" className="button small secondary" onClick={() => setForm(current => ({
                    ...current,
                    additionalDetails: [...(current.additionalDetails || []), { id: createId(), label: '', value: '' }],
                  }))}>+ Adicionar campo</button>
                </div>
              )}

              <button className="button green full" type="submit">{editingParcel ? 'Atualizar encomenda' : 'Registrar recebimento'}</button>
              {editingParcel && <button className="button secondary full" type="button" onClick={() => { setEditingParcel(null); setForm(emptyForm()); }}>Cancelar edição</button>}
            </form>
          </div>
          <div className="panel">
            <div className="section-heading"><h2>Encomendas de hoje</h2><span className="count-pill">{todayParcels.length}</span></div>
            <input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por morador, apto ou transportadora" />
            {filteredParcels.length ? filteredParcels.map(renderParcelCard) : <p className="empty">Nenhuma encomenda encontrada hoje.</p>}
          </div>
        </section>}

        {tab === 'residents' && <section>
          <div className="panel">
            <h2>{editingResidentId ? 'Editar morador' : 'Cadastrar morador'}</h2>
            <form onSubmit={saveResident}>
              <div className="resident-photo-box">
                <label className="field-label photo-field-label">Foto do morador<input type="file" accept="image/*" onChange={handleResidentPhotoChange} /></label>
                {residentForm.photo ? <img className="resident-photo-preview" src={residentForm.photo} alt="Foto do morador" /> : <div className="resident-photo-empty">Sem foto</div>}
              </div>

              <label className="field-label">Nome<input required value={residentForm.name} onChange={event => setResidentForm(current => ({ ...current, name: event.target.value }))} /></label>
              <label className="field-label">Apartamento / bloco<input required value={residentForm.apartment} onChange={event => setResidentForm(current => ({ ...current, apartment: event.target.value }))} /></label>
              <label className="field-label">Telefone (opcional)<input type="tel" value={residentForm.phone} onChange={event => setResidentForm(current => ({ ...current, phone: event.target.value }))} /></label>

              <div className="family-section">
                <div className="section-heading family-heading">
                  <h3>Familiares</h3>
                  <button type="button" className="button small secondary" onClick={addFamilyMember}>+ Familiar</button>
                </div>

                {(residentForm.family || []).length ? (residentForm.family || []).map((member, index) => (
                  <div className="family-member-card" key={member.id || index}>
                    <div className="family-member-header">
                      <h4>Familiar {index + 1}</h4>
                      <button type="button" className="button small red" onClick={() => removeFamilyMember(index)}>Remover</button>
                    </div>

                    <div className="family-photo-row">
                      <label className="upload-photo-button"><span>Foto</span><input type="file" accept="image/*" onChange={event => handleFamilyPhotoChange(event, index)} /></label>
                      {member.photo ? <img className="family-photo-preview" src={member.photo} alt={`Foto do familiar ${index + 1}`} /> : <div className="family-photo-placeholder">Sem foto</div>}
                    </div>

                    <label className="field-label">Nome<input value={member.name || ''} onChange={event => updateFamilyMember(index, 'name', event.target.value)} /></label>
                    <label className="field-label">Parentesco<input value={member.relation || ''} onChange={event => updateFamilyMember(index, 'relation', event.target.value)} /></label>
                  </div>
                )) : <p className="empty">Nenhum familiar adicionado.</p>}
              </div>

              <button className="button green full" type="submit">{editingResidentId ? 'Salvar alterações' : 'Cadastrar morador'}</button>
            </form>
          </div>

          <div className="panel">
            <h2>Moradores cadastrados</h2>
            {residents.length ? residents.map(resident => (
              <article className="list-card resident-card" key={resident.id}>
                <div className="resident-card-header">
                  {resident.photo ? <img className="resident-avatar" src={resident.photo} alt={resident.name} /> : <div className="resident-avatar empty-avatar">N</div>}
                  <div>
                    <h3>{resident.name}</h3>
                    <p>{resident.apartment}</p>
                  </div>
                </div>
                {resident.phone && <p className="muted">{resident.phone}</p>}
                <p className="muted">{(resident.family || []).length} familiar(es)</p>
                <div className="button-row"><button className="button small secondary" onClick={() => editResident(resident)}>Editar</button></div>
              </article>
            )) : <p className="empty">Nenhum morador cadastrado.</p>}
          </div>
        </section>}

        {tab === 'reports' && <section className="panel"><h2>Relatórios PDF</h2><p className="help-text">Os registros ficam salvos neste celular. Exporte cópias periódicas para não perder os dados.</p>{reportDays.length ? reportDays.map(day => <div className="report-row" key={day}><strong>{day}</strong><button className="button small green" onClick={() => exportPdf(day)}>Baixar PDF</button></div>) : <p className="empty">Ainda não há relatórios.</p>}</section>}

        {tab === 'settings' && <section className="panel"><h2>Leitura inteligente</h2><p className="help-text">O app usa OCR e pode relacionar nomes de moradores e familiares com a etiqueta da encomenda.</p><div className="subheading">Memória local</div>{memory.length ? memory.slice(0, 10).map((item, index) => <div className="memory-row" key={`${item.keyword}-${index}`}><span>{item.keyword}</span><strong>{item.carrier}</strong></div>) : <p className="empty">Ainda não há memórias salvas.</p>}</section>}
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
