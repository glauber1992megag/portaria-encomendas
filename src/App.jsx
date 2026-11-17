import { getAiBackup, saveAiBackup } from './aiBackup.js';
import React, { useEffect, useMemo, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { createWorker } from 'tesseract.js';
import { jsPDF } from 'jspdf';
import {
  getLocalAiMemory,
  restoreAiMemory,
  saveAiMemory,
} from './aiBackup.js';

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

function emptyResidentForm() {
  return { name: '', apartment: '', phone: '', photo: '', family: [] };
}

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());
}

function cleanupExtraDetails(details = []) {
  return (Array.isArray(details) ? details : [])
    .filter(item => item && (item.label?.trim() || item.value?.trim()))
    .map(item => ({ ...item, label: item.label || '', value: item.value || '' }));
}

async function prepImageForOcr(source) {
  let objectUrl;
  const imageUrl = source instanceof Blob ? (objectUrl = URL.createObjectURL(source)) : source;

  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Não foi possível abrir a imagem.'));
      element.src = imageUrl;
    });

    const maxSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const scale = Math.min(2, 1800 / maxSide);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível neste dispositivo.');

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.filter = 'grayscale(1) contrast(1.45)';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', 0.92);
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function cleanLine(line = '') {
  return String(line).replace(/\s+/g, ' ').trim();
}

function extractBestResident(text) {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const explicit = ['DESTINATARIO', 'DESTINATÁRIO', 'RECEBEDOR', 'CLIENTE', 'DESTINO'];

  const findByLabel = labels => {
    for (let i = 0; i < lines.length; i += 1) {
      const line = normalize(lines[i]);
      const found = labels.find(label => line.includes(normalize(label)));
      if (!found) continue;

      const index = line.indexOf(normalize(found));
      const tail = lines[i].slice(index + found.length).replace(/^\s*[:#-]?\s*/, '').trim();
      if (tail && tail.length > 2) return tail;
      if (lines[i + 1]) return lines[i + 1];
    }
    return '';
  };

  const candidate = findByLabel(explicit);
  if (candidate) return candidate;

  const addressBlock = lines.findIndex(line => /\b(RUA|AV\.?|AVENIDA|ALAMEDA|TRAVESSA)\b/i.test(line));
  if (addressBlock > 0) {
    const nearby = lines
      .slice(Math.max(0, addressBlock - 3), addressBlock)
      .reverse()
      .find(line =>
        /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(line) &&
        !/\b(AMAZON|BRASIL|FRETE|GRATIS|RAPIDO|PEDIDO|ENTREGA)\b/i.test(normalize(line))
      );

    if (nearby) return nearby.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ.' -]+$/g, '').trim();
  }

  return '';
}

function extractBestApartment(text) {
  const lineText = normalize(text);
  const labelMatch = /(?:APTO|APT|APARTAMENTO)\s*[:#-]?\s*([0-9A-Z]+)/i.exec(lineText);
  if (labelMatch) return `Apto ${labelMatch[1]}`;

  const fallbackMatch = /\b([0-9]{3,4})\b/.exec(text);
  if (fallbackMatch) return `Apto ${fallbackMatch[1]}`;

  return '';
}

function extractBestCarrier(text) {
  const normalized = normalize(text);
  const carrier = CARRIER_HINTS.find(([needle]) => normalized.includes(needle));
  if (carrier) return carrier[1];

  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = normalize(lines[i]);
    if (line.includes('TRANSPORTADORA')) {
      const tail = lines[i].replace(/.*TRANSPORTADORA/i, '').replace(/^\s*[:#-]?\s*/, '').trim();
      return tail || '';
    }
  }

  return '';
}

function extractBestTracking(text) {
  const normalized = normalize(text);
  const explicit = ['RASTREAMENTO', 'RASTREIO', 'TRACKING', 'CODIGO DO OBJETO', 'OBJETO'];

  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = normalize(lines[i]);
    const found = explicit.find(label => line.includes(normalize(label)));
    if (!found) continue;

    const tail = lines[i].replace(new RegExp(found, 'ig'), '').replace(/^\s*[:#-]?\s*/, '').trim();
    if (tail) return tail;
  }

  const match = /\b[A-Z]{2,5}\d{6,}[A-Z0-9]*\b/.exec(normalized);
  if (match) return match[0];

  return '';
}

function parseOcrText(text) {
  const result = {
    resident: extractBestResident(text),
    apartment: extractBestApartment(text),
    carrier: extractBestCarrier(text),
    tracking: extractBestTracking(text),
  };

  if (!result.apartment && /\b([0-9]{3,4})\b/.test(text)) {
    const found = text.match(/\b([0-9]{3,4})\b/);
    if (found) result.apartment = `Apto ${found[1]}`;
  }

  return result;
}

export default function App() {
  const [residents, setResidents] = useState(() => load(STORAGE.residents, []));
  const [parcels, setParcels] = useState(() => load(STORAGE.parcels, {}));
  const [memory, setMemory] = useState(() => {
  const localMemory = load(STORAGE.memory, []);
  return localMemory.length ? localMemory : getLocalAiMemory();
});
  const [form, setForm] = useState(emptyForm);
  const [residentForm, setResidentForm] = useState(emptyResidentForm);
  const [editingResidentId, setEditingResidentId] = useState(null);
  const [editingParcel, setEditingParcel] = useState(null);
  const [tab, setTab] = useState('desk');
  const [notice, setNotice] = useState({
    text: 'Registre a encomenda manualmente ou leia a etiqueta pela câmera.',
    type: 'info',
  });
  const [busy, setBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState('');
  const [query, setQuery] = useState('');
  const [ocrText, setOcrText] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE.residents, JSON.stringify(residents));
  }, [residents]);

  useEffect(() => {
    localStorage.setItem(STORAGE.parcels, JSON.stringify(parcels));
  }, [parcels]);

  useEffect(() => {
  let active = true;

  async function restoreMemory() {
    const restoredMemory = await restoreAiMemory();

    if (active && restoredMemory.length) {
      setMemory(restoredMemory);
    }
  }

  restoreMemory();

  return () => {
    active = false;
  };
}, []);

  const today = localDateKey();
  const todayParcels = parcels[today] || [];

  const pendingParcels = useMemo(() => {
    return Object.entries(parcels)
      .flatMap(([day, items]) => {
        const normalizedItems = Array.isArray(items) ? items : [];
        return normalizedItems
          .filter(item => item && item.status !== 'Retirado')
          .map(item => ({ ...item, day }));
      })
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
  }, [parcels]);

  function parcelSearchText(item) {
    const data = item?.data || {};
    return Object.entries(data)
      .flatMap(([_, value]) => {
        if (Array.isArray(value)) {
          return value.flatMap(entry => {
            if (typeof entry === 'object' && entry !== null) {
              return [`${entry.label || ''}`, `${entry.value || ''}`];
            }
            return [String(entry)];
          });
        }

        if (value && typeof value === 'object') {
          return [JSON.stringify(value)];
        }

        return [String(value)];
      })
      .join(' ');
  }

  const filteredParcels = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return todayParcels;

    return todayParcels.filter(item => normalize(parcelSearchText(item)).includes(term));
  }, [todayParcels, query]);

  const filteredPending = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return pendingParcels;

    return pendingParcels.filter(item => normalize(parcelSearchText(item) + ` ${item.day}`).includes(term));
  }, [pendingParcels, query]);

  function updateField(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function applyLabelText(text) {
    setOcrText(text);

    if (!text.trim()) {
      setNotice({
        text: 'A imagem foi processada, mas nenhum texto foi reconhecido. Tente aproximar e iluminar melhor a etiqueta.',
        type: 'error',
      });
      return;
    }

    const parsed = parseOcrText(text);

    setForm(current => ({
      ...current,
      resident: parsed.resident || current.resident,
      apartment: parsed.apartment || current.apartment,
      carrier: parsed.carrier || current.carrier,
      tracking: parsed.tracking || current.tracking,
    }));

    const matched = Object.values(parsed).filter(Boolean).length;
    setNotice({
      text: matched
        ? `Texto reconhecido. ${matched} campo(s) sugerido(s); revise os dados e confirme antes de salvar.`
        : 'O texto foi reconhecido, mas não encontrei campos automaticamente. Confira o texto e complete manualmente.',
      type: matched ? 'success' : 'info',
    });
  }

  async function recognizeImage(image) {
    setBusy(true);
    setOcrProgress('Preparando imagem…');
    setOcrText('');
    setNotice({
      text: 'Preparando a etiqueta para leitura. Na primeira leitura, conecte o celular à internet para baixar o idioma português.',
      type: 'info',
    });

    let worker;

    try {
      const preparedImage = await prepImageForOcr(image);
      worker = await createWorker('por', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            setOcrProgress(`Lendo texto: ${Math.round((message.progress || 0) * 100)}%`);
          } else if (message.status === 'loading language traineddata') {
            setOcrProgress('Baixando idioma português…');
          } else if (message.status) {
            setOcrProgress('Iniciando OCR…');
          }
        },
      });

      const result = await worker.recognize(preparedImage);
      const recognizedText = result.data.text || '';

      if (recognizedText.trim().length < 24) {
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        const retry = await worker.recognize(preparedImage);

        if ((retry.data.text || '').trim().length > recognizedText.trim().length) {
          applyLabelText(retry.data.text || recognizedText);
        } else {
          applyLabelText(recognizedText);
        }
      } else {
        applyLabelText(recognizedText);
      }
    } catch (error) {
      console.error('Falha no OCR:', error);
      setNotice({
        text: 'Não foi possível processar a imagem. Verifique a internet na primeira leitura, tente outra foto ou preencha manualmente.',
        type: 'error',
      });
    } finally {
      if (worker) await worker.terminate().catch(() => {});
      setBusy(false);
      setOcrProgress('');
    }
  }

  async function takePhoto() {
    try {
      const photo = await Camera.getPhoto({
        quality: 95,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        correctOrientation: true,
      });

      if (photo.dataUrl) {
        await recognizeImage(photo.dataUrl);
      }
    } catch (error) {
      setNotice({
        text: 'Câmera cancelada ou sem permissão. Você também pode escolher uma foto da galeria.',
        type: 'error',
      });
    }
  }

  async function chooseImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      await recognizeImage(file);
    }
  }

  function saveParcel(event) {
    event.preventDefault();

    if (!form.resident.trim() && !form.apartment.trim()) {
      setNotice({
        text: 'Informe pelo menos o nome do morador ou o apartamento.',
        type: 'error',
      });
      return;
    }

    const cleanedExtraDetails = cleanupExtraDetails(form.extraDetails);

    const entry = {
      id: editingParcel?.id || newId(),
      receivedAt: editingParcel?.receivedAt || new Date().toISOString(),
      status: editingParcel?.status || 'Pendente',
      pickedUpBy: editingParcel?.pickedUpBy || '',
      leftAt: editingParcel?.leftAt || '',
      data: {
        ...form,
        extraDetails: cleanedExtraDetails,
      },
    };

    const targetDay = editingParcel?.day || today;

    setParcels(current => {
      const next = { ...current };
      const items = [...(next[targetDay] || [])];
      const index = items.findIndex(item => item.id === entry.id);
      if (index >= 0) items[index] = entry;
      else items.unshift(entry);
      next[targetDay] = items;
      return next;
    });

    if (ocrText && form.carrier.trim()) {
      const keyword = normalize(ocrText)
        .split(/\s+/)
        .map(word => word.replace(/[^A-Z0-9]/g, ''))
        .find(word => word.length >= 5);

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
      [parcel.day]: (current[parcel.day] || []).map(item =>
        item.id === parcel.id
          ? {
              ...item,
              status: 'Retirado',
              pickedUpBy: pickedUpBy.trim(),
              leftAt: new Date().toISOString(),
            }
          : item
      ),
    }));
  }

  function deleteParcel(parcel) {
    if (!window.confirm('Excluir esta encomenda?')) return;

    setParcels(current => ({
      ...current,
      [parcel.day]: (current[parcel.day] || []).filter(item => item.id !== parcel.id),
    }));
  }

  function addFamilyMember() {
    setResidentForm(current => ({
      ...current,
      family: [...(current.family || []), { id: newId(), name: '', relation: '' }],
    }));
  }

  function updateFamilyMember(id, key, value) {
    setResidentForm(current => ({
      ...current,
      family: (current.family || []).map(person =>
        person.id === id ? { ...person, [key]: value } : person
      ),
    }));
  }

  function saveResident(event) {
    event.preventDefault();

    if (!residentForm.name.trim() || !residentForm.apartment.trim()) {
      setNotice({
        text: 'Informe o nome e o apartamento do morador.',
        type: 'error',
      });
      return;
    }

    const resident = {
      ...residentForm,
      id: editingResidentId || newId(),
      family: (residentForm.family || []).filter(person => person.name.trim()),
    };

    setResidents(current =>
      editingResidentId
        ? current.map(item => (item.id === editingResidentId ? resident : item))
        : [resident, ...current]
    );

    setResidentForm(emptyResidentForm());
    setEditingResidentId(null);
    setNotice({ text: 'Cadastro salvo com sucesso.', type: 'success' });
  }

  function editResident(resident) {
    setResidentForm({
      name: resident.name || '',
      apartment: resident.apartment || '',
      phone: resident.phone || '',
      photo: resident.photo || '',
      family: resident.family || [],
    });
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
      setNotice({
        text: 'Não foi possível carregar essa foto. Tente outra imagem.',
        type: 'error',
      });
    }
  }

  function deleteResident(resident) {
    if (!window.confirm(`Excluir o cadastro de ${resident.name}?`)) return;
    setResidents(current => current.filter(item => item.id !== resident.id));
  }

  async function exportPdf(day) {
    const doc = new jsPDF();
    const rows = parcels[day] || [];

    doc.setFontSize(16);
    doc.text(`Relatório de encomendas - ${day}`, 14, 18);
    doc.setFontSize(10);

    let y = 30;

    rows.forEach((item, index) => {
      const received = item.receivedAt ? new Date(item.receivedAt).toLocaleString('pt-BR') : 'Não informado';
      const left = item.leftAt ? new Date(item.leftAt).toLocaleString('pt-BR') : 'Ainda pendente';
      const details = FIELD_LIST.map(field => item.data[field.id] ? `${field.label}: ${item.data[field.id]}` : '')
        .filter(Boolean)
        .join(' | ');

      const extra = (item.data.extraDetails || [])
        .map(detail => `${detail.label || 'Detalhe'}: ${detail.value || ''}`)
        .join(' | ');

      const lines = doc.splitTextToSize(
        `${index + 1}. ${item.status || 'Pendente'} | Recebido: ${received} | Retirada: ${left}${item.pickedUpBy ? ` por ${item.pickedUpBy}` : ''} | ${details}${extra ? ` | ${extra}` : ''}`,
        180
      );

      if (y + lines.length * 6 > 280) {
        doc.addPage();
        y = 20;
      }

      doc.text(lines, 14, y);
      y += lines.length * 6 + 5;
    });

    const filename = `portaria-encomendas-${day}.pdf`;

    if (!Capacitor.isNativePlatform()) {
      doc.save(filename);
      return;
    }

    try {
      const dataUri = doc.output('datauristring');
      await Filesystem.writeFile({
        path: `relatorio de encomendas/${filename}`,
        data: dataUri.slice(dataUri.indexOf(',') + 1),
        directory: Directory.Documents,
        recursive: true,
      });
      window.alert(`PDF salvo na pasta de documentos do app: relatorio de encomendas/${filename}.`);
    } catch (error) {
      console.error('Falha ao salvar PDF no aparelho:', error);
      doc.save(filename);
      window.alert('Não foi possível salvar na pasta do app. O PDF foi baixado pelo método alternativo.');
    }
  }

  function renderParcelCard(parcel) {
    const received = parcel.receivedAt ? new Date(parcel.receivedAt).toLocaleString('pt-BR') : 'Data não informada';
    const extraDetails = Array.isArray(parcel.data.extraDetails) ? parcel.data.extraDetails : [];

    return (
      <article className="list-card" key={`${parcel.day}-${parcel.id}`}>
        <div className="card-topline">
          <span className={`badge ${parcel.status === 'Retirado' ? 'badge-done' : 'badge-pending'}`}>
            {parcel.status || 'Pendente'}
          </span>
          <span className="muted">Recebido: {received}</span>
        </div>

        <h3>{parcel.data.resident || 'Morador não informado'}</h3>
        <p>
          {parcel.data.apartment || 'Apartamento não informado'}
          {parcel.data.carrier ? ` · ${parcel.data.carrier}` : ''}
        </p>
        {parcel.data.tracking && <p className="muted">{parcel.data.tracking}</p>}

        {extraDetails
          .filter(item => item && (item.label || item.value))
          .map((item, index) => (
            <p className="muted" key={item.id || index}>
              {item.label || 'Detalhe'}: {item.value}
            </p>
          ))}

        {parcel.status === 'Retirado' && (
          <p className="muted">
            Retirado por {parcel.pickedUpBy} ·{' '}
            {parcel.leftAt ? new Date(parcel.leftAt).toLocaleString('pt-BR') : ''}
          </p>
        )}

        <div className="button-row">
          {parcel.status !== 'Retirado' && (
            <button
              className="button small green"
              type="button"
              onClick={() => markPickedUp(parcel)}
            >
              Registrar retirada
            </button>
          )}

          <button
            className="button small secondary"
            type="button"
            onClick={() => {
              setEditingParcel(parcel);
              setForm({
                ...emptyForm(),
                ...parcel.data,
                extraDetails: cleanupExtraDetails(parcel.data.extraDetails),
              });
              setTab('desk');
            }}
          >
            Editar
          </button>

          <button
            className="button small red"
            type="button"
            onClick={() => deleteParcel(parcel)}
          >
            Excluir
          </button>
        </div>
      </article>
    );
  }

  const reportDays = Object.keys(parcels).sort().reverse();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">CONTROLE DE ENTREGAS</p>
          <h1>Portaria</h1>
        </div>
        <button
          className="button header-button"
          type="button"
          onClick={() => {
            setTab('residents');
            setEditingParcel(null);
          }}
        >
          + Morador
        </button>
      </header>

      <main className="main-content">
        {tab === 'desk' && (
          <section>
            <div className="panel">
              <h2>{editingParcel ? 'Editar encomenda' : 'Receber encomenda'}</h2>
              <p className="help-text">
                Fotografe a etiqueta ou preencha os dados. O OCR é uma sugestão: confirme antes de salvar.
              </p>

              <div className="capture-grid">
                <button
                  type="button"
                  className="button camera-button"
                  disabled={busy}
                  onClick={takePhoto}
                >
                  {busy ? 'Lendo etiqueta…' : 'Abrir câmera'}
                </button>

                <label className="gallery-button">
                  <span>Escolher foto</span>
                  <input type="file" accept="image/*" onChange={chooseImage} />
                </label>
              </div>

              <div className={`notice ${notice.type}`} role="status" aria-live="polite">
                {busy && ocrProgress ? `${notice.text} ${ocrProgress}` : notice.text}
              </div>

              {!!ocrText && (
                <div className="ocr-result">
                  <label className="field-label" htmlFor="ocr-text">Texto reconhecido</label>
                  <textarea
                    id="ocr-text"
                    value={ocrText}
                    onChange={event => setOcrText(event.target.value)}
                  />
                </div>
              )}

              <form onSubmit={saveParcel}>
                {FIELD_LIST.map(field => (
                  <label className="field-label" key={field.id}>
                    {field.label}
                    <input
                      value={form[field.id] || ''}
                      onChange={event => updateField(field.id, event.target.value)}
                      placeholder="Confira e complete os dados"
                    />
                  </label>
                ))}

                <div className="section-heading extra-heading">
                  <h3>Detalhes adicionais da etiqueta</h3>
                </div>

                {(form.extraDetails || []).map((detail, index) => (
                  <div key={detail.id || index} className="extra-detail-row">
                    <label className="field-label">
                      Detalhe
                      <input
                        value={detail.label || ''}
                        onChange={event => {
                          const next = [...(form.extraDetails || [])];
                          next[index].label = event.target.value;
                          updateField('extraDetails', next);
                        }}
                      />
                    </label>

                    <label className="field-label">
                      Valor
                      <input
                        value={detail.value || ''}
                        onChange={event => {
                          const next = [...(form.extraDetails || [])];
                          next[index].value = event.target.value;
                          updateField('extraDetails', next);
                        }}
                      />
                    </label>
                  </div>
                ))}

                <button
                  type="button"
                  className="button secondary full"
                  onClick={() => setForm(current => ({
                    ...current,
                    extraDetails: [...(current.extraDetails || []), { id: newId(), label: '', value: '' }],
                  }))}
                >
                  + Adicionar detalhe
                </button>

                <button className="button green full" type="submit">
                  {editingParcel ? 'Atualizar encomenda' : 'Registrar recebimento'}
                </button>

                {editingParcel && (
                  <button
                    type="button"
                    className="button secondary full"
                    onClick={() => {
                      setEditingParcel(null);
                      setForm(emptyForm());
                    }}
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            </div>

            <div className="panel">
              <div className="section-heading">
                <h2>Encomendas de hoje</h2>
                <span className="count-pill">{todayParcels.length}</span>
              </div>

              <input
                className="search-input"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Buscar por nome, apartamento ou código"
              />

              {filteredParcels.length ? (
                filteredParcels.map(parcel => renderParcelCard({ ...parcel, day: today }))
              ) : (
                <p className="empty">Nenhuma encomenda encontrada hoje.</p>
              )}
            </div>

            <div className="panel">
              <div className="section-heading">
                <h2>Encomendas pendentes</h2>
                <span className="count-pill">{pendingParcels.length}</span>
              </div>

              <p className="help-text">Inclui encomendas ainda não retiradas.</p>

              {filteredPending.length ? (
                filteredPending.map(parcel => renderParcelCard(parcel))
              ) : (
                <p className="empty">Nenhuma encomenda pendente encontrada.</p>
              )}
            </div>
          </section>
        )}

        {tab === 'residents' && (
          <section>
            <div className="panel">
              <h2>{editingResidentId ? 'Editar morador' : 'Cadastrar morador'}</h2>

              <form onSubmit={saveResident}>
                <label className="field-label">
                  Nome
                  <input
                    required
                    value={residentForm.name}
                    onChange={event => setResidentForm(current => ({ ...current, name: event.target.value }))}
                    autoComplete="name"
                  />
                </label>

                <label className="field-label">
                  Apartamento / bloco
                  <input
                    required
                    value={residentForm.apartment}
                    onChange={event => setResidentForm(current => ({ ...current, apartment: event.target.value }))}
                  />
                </label>

                <label className="field-label">
                  Telefone (opcional)
                  <input
                    type="tel"
                    value={residentForm.phone}
                    onChange={event => setResidentForm(current => ({ ...current, phone: event.target.value }))}
                  />
                </label>

                <label className="field-label">
                  Foto do morador
                  <input type="file" accept="image/*" onChange={chooseResidentPhoto} />
                </label>

                {residentForm.photo && (
                  <img
                    src={residentForm.photo}
                    alt="Prévia da foto do morador"
                    className="resident-preview"
                  />
                )}

                <div className="section-heading family-heading">
                  <h3>Parentes / membros do apartamento</h3>
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={addFamilyMember}
                  >
                    + Adicionar familiar
                  </button>
                </div>

                {(residentForm.family || []).map((person, index) => (
                  <div className="list-card" key={person.id || index}>
                    <label className="field-label">
                      Nome
                      <input
                        value={person.name || ''}
                        onChange={event =>
                          setResidentForm(current => ({
                            ...current,
                            family: (current.family || []).map(item =>
                              item.id === person.id ? { ...item, name: event.target.value } : item
                            ),
                          }))
                        }
                      />
                    </label>

                    <label className="field-label">
                      Parentesco
                      <input
                        value={person.relation || ''}
                        onChange={event =>
                          setResidentForm(current => ({
                            ...current,
                            family: (current.family || []).map(item =>
                              item.id === person.id ? { ...item, relation: event.target.value } : item
                            ),
                          }))
                        }
                      />
                    </label>
                  </div>
                ))}

                <button className="button green full" type="submit">
                  {editingResidentId ? 'Salvar alterações' : 'Cadastrar morador'}
                </button>

                {editingResidentId && (
                  <button
                    type="button"
                    className="button secondary full"
                    onClick={() => {
                      setEditingResidentId(null);
                      setResidentForm(emptyResidentForm());
                    }}
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            </div>

            <div className="panel">
              <h2>Moradores cadastrados</h2>

              <input
                className="search-input"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Buscar morador por nome ou apartamento"
              />

              {residents.length ? (
                <div className="resident-directory">
                  {residents
                    .filter(resident => {
                      const term = normalize(query.trim());
                      if (!term) return true;

                      return normalize(`${resident.name} ${resident.apartment} ${resident.phone}`)
                        .includes(term);
                    })
                    .sort((a, b) => {
                      const apartmentA = Number.parseInt((a.apartment || '').match(/\d+/)?.[0] || '9999', 10);
                      const apartmentB = Number.parseInt((b.apartment || '').match(/\d+/)?.[0] || '9999', 10);
                      return apartmentA - apartmentB || (a.name || '').localeCompare(b.name || '', 'pt-BR');
                    })
                    .map(resident => (
                      <article className="list-card resident-card" key={resident.id}>
                        <div className="resident-card-header">
                          <h3>{resident.name}</h3>
                          <span className="resident-apartment-pill">{resident.apartment}</span>
                        </div>

                        <p>{resident.phone ? `WhatsApp: ${resident.phone}` : 'WhatsApp não informado'}</p>

                        {(resident.family || []).length > 0 && (
                          <div className="resident-family">
                            {(resident.family || []).map((person, index) => (
                              <div key={person.id || index} className="resident-family-item">
                                {person.name} {person.relation ? `(${person.relation})` : ''}
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="button-row">
                          <button
                            className="button small secondary"
                            type="button"
                            onClick={() => editResident(resident)}
                          >
                            Editar
                          </button>

                          <button
                            className="button small red"
                            type="button"
                            onClick={() => deleteResident(resident)}
                          >
                            Excluir
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              ) : (
                <p className="empty">Nenhum morador cadastrado.</p>
              )}
            </div>
          </section>
        )}

        {tab === 'reports' && (
          <section className="panel">
            <h2>Relatórios PDF</h2>
            <p className="help-text">
              No Android, os arquivos ficam no armazenamento de documentos do app, na pasta “relatorio de encomendas”.
            </p>

            {reportDays.length ? (
              reportDays.map(day => (
                <div key={day} className="report-row" role="presentation">
                  <span>{day}</span>
                  <button
                    className="button small green"
                    type="button"
                    onClick={() => exportPdf(day)}
                  >
                    Baixar PDF
                  </button>
                </div>
              ))
            ) : (
              <p className="empty">Ainda não há relatórios.</p>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <section className="panel">
            <h2>Leitura inteligente</h2>
            <p className="help-text">
              Na primeira leitura, conecte o celular à internet para baixar o idioma português do OCR.
            </p>
          </section>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Navegação principal">
        <button className={tab === 'desk' ? 'active' : ''} onClick={() => setTab('desk')}>
          <span>⌂</span>Portaria
        </button>
        <button className={tab === 'residents' ? 'active' : ''} onClick={() => setTab('residents')}>
          <span>👤</span>Moradores
        </button>
        <button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>
          <span>📄</span>Relatórios
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span>⚙️</span>OCR
        </button>
      </nav>
    </div>
  );
}
