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
  { id: 'apartment', label: 'Apartamento / bloco (AP, apt, apto)' },
  { id: 'resident', label: 'Destinatário (Morador)' },
  { id: 'barcode', label: 'Código de barras' },
  { id: 'tracking', label: 'Código de rastreio' },
  { id: 'orderNumber', label: 'Número do pedido' },
  { id: 'invoice', label: 'Nota Fiscal (NF / NF-e)' },
  { id: 'carrier', label: 'Transportadora' },
];

const CARRIER_HINTS = [
  ['MERCADO LIVRE', 'Mercado Livre'],
  ['MERCADOLIVRE', 'Mercado Livre'],
  ['MERCADO ENVIOS', 'Mercado Livre'],
  ['AMAZON', 'Amazon'],
  ['SHOPEE', 'Shopee'],
  ['CORREIOS', 'Correios'],
  ['SEDEX', 'Correios'],
  ['PAC', 'Correios'],
  ['MAGALU', 'Magalu Entregas'],
  ['JADLOG', 'Jadlog'],
  ['LOGGI', 'Loggi'],
  ['TOTAL EXPRESS', 'Total Express'],
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
  return {
    apartment: '',
    resident: '',
    barcode: '',
    tracking: '',
    orderNumber: '',
    invoice: '',
    carrier: '',
    extraDetails: [],
  };
}

function emptyResidentForm() {
  return { name: '', apartment: '', phone: '', photo: '', family: [] };
}

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR');
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());
}

function cleanupExtraDetails(details = []) {
  return (Array.isArray(details) ? details : [])
    .filter(item => item && (item.label?.trim() || item.value?.trim()))
    .map(item => ({ ...item, label: item.label || '', value: item.value || '' }));
}

function cleanLine(line = '') {
  return String(line).replace(/\s+/g, ' ').trim();
}

async function detectBarcodeFromImage(imageSource) {
  let objectUrl = '';
  try {
    if (!('BarcodeDetector' in window)) return '';
    const detector = new window.BarcodeDetector({
      formats: ['code_128', 'code_39', 'ean_13', 'itf', 'qr_code', 'codabar'],
    });

    const img = new Image();
    if (typeof imageSource === 'string') {
      img.src = imageSource;
    } else {
      objectUrl = URL.createObjectURL(imageSource);
      img.src = objectUrl;
    }

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const barcodes = await detector.detect(img);
    if (barcodes && barcodes.length > 0) {
      barcodes.sort((a, b) => (b.rawValue?.length || 0) - (a.rawValue?.length || 0));
      return barcodes[0].rawValue || '';
    }
  } catch {
    return '';
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
  return '';
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
    const scale = Math.min(2, 2000 / maxSide);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível neste dispositivo.');

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.filter = 'grayscale(1) contrast(1.55)';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', 0.94);
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function parseOcrTextSmart(text, memory = [], residents = [], detectedBarcode = '') {
  const normalizedFull = normalize(text);
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);

  const result = {
    apartment: '',
    resident: '',
    barcode: detectedBarcode || '',
    tracking: '',
    orderNumber: '',
    invoice: '',
    carrier: '',
  };

  for (const rule of memory) {
    if (!rule.trigger || !rule.field || !rule.targetValue) continue;
    if (normalizedFull.includes(normalize(rule.trigger))) {
      if (!result[rule.field]) {
        result[rule.field] = rule.targetValue;
      }
    }
  }

  if (!result.resident) {
    for (const res of residents) {
      const resNorm = normalize(res.name);
      if (resNorm.length >= 4 && normalizedFull.includes(resNorm)) {
        result.resident = res.name;
        if (!result.apartment && res.apartment) result.apartment = res.apartment;
        break;
      }
      const fam = (res.family || []).find(
        f => f.name && normalize(f.name).length >= 4 && normalizedFull.includes(normalize(f.name))
      );
      if (fam) {
        result.resident = `${fam.name} (${res.name})`;
        if (!result.apartment && res.apartment) result.apartment = res.apartment;
        break;
      }
    }
  }

  if (!result.apartment) {
    const aptMatch = /(?:APTO|APT|APARTAMENTO|AP|UNIDADE)\s*\.?\s*[:#-]?\s*([0-9]+[A-Z0-9\-\/]*)/i.exec(normalizedFull);
    if (aptMatch) {
      const blockMatch = /(?:BLOCO|BL|TORRE)\s*\.?\s*[:#-]?\s*([A-Z0-9]+)/i.exec(normalizedFull);
      result.apartment = blockMatch ? `Apto ${aptMatch[1]} - Bloco ${blockMatch[1]}` : `Apto ${aptMatch[1]}`;
    }
  }

  if (!result.invoice) {
    const nfMatch = /(?:NF-E|NFE|NF|NOTA\s*FISCAL|DANFE)\s*(?:N[Oº°]?\.?)?\s*[:#-]?\s*([0-9\.\-]{3,20})/i.exec(normalizedFull);
    if (nfMatch) {
      result.invoice = nfMatch[1].replace(/\.$/, '');
    }
  }

  if (!result.orderNumber) {
    const orderMatch = /(?:PEDIDO|ORDER|ID\s*PEDIDO|COMPRA)\s*(?:N[Oº°]?\.?)?\s*[:#-]?\s*([A-Z0-9\-]{5,25})/i.exec(normalizedFull);
    if (orderMatch) {
      result.orderNumber = orderMatch[1];
    }
  }

  if (!result.tracking) {
    const trackingLabelMatch = /(?:RASTREAMENTO|RASTREIO|TRACKING|OBJETO|CODIGO\s*DO\s*OBJETO)\s*[:#-]?\s*([A-Z0-9\-]{8,25})/i.exec(normalizedFull);
    if (trackingLabelMatch) {
      result.tracking = trackingLabelMatch[1];
    } else {
      const correiosMatch = /\b[A-Z]{2}\d{9}[A-Z]{2}\b/.exec(normalizedFull);
      const genericTrackMatch = /\b(?:TBR|BR|ML|SP|AMZ)[0-9A-Z]{7,20}\b/.exec(normalizedFull);
      if (correiosMatch) result.tracking = correiosMatch[0];
      else if (genericTrackMatch) result.tracking = genericTrackMatch[0];
      else if (detectedBarcode) result.tracking = detectedBarcode;
    }
  }

  if (!result.barcode) {
    const longDigits = normalizedFull.match(/\b\d{12,44}\b/);
    if (longDigits) result.barcode = longDigits[0];
  }

  if (!result.carrier) {
    const carrier = CARRIER_HINTS.find(([needle]) => normalizedFull.includes(needle));
    if (carrier) result.carrier = carrier[1];
  }

  if (!result.resident) {
    const explicit = ['DESTINATARIO', 'RECEBEDOR', 'CLIENTE', 'PARA:', 'NOME:'];
    for (let i = 0; i < lines.length; i += 1) {
      const lineNorm = normalize(lines[i]);
      const found = explicit.find(label => lineNorm.includes(label));
      if (!found) continue;

      const idx = lineNorm.indexOf(found);
      const tail = lines[i].slice(idx + found.length).replace(/^\s*[:#-]?\s*/, '').trim();
      if (tail.length > 3 && !/\d{4,}/.test(tail)) {
        result.resident = tail;
        break;
      }
      if (lines[i + 1] && lines[i + 1].length > 3 && !/\d{4,}/.test(lines[i + 1])) {
        result.resident = lines[i + 1];
        break;
      }
    }
  }

  if (!result.resident) {
    const addressBlock = lines.findIndex(line => /\b(RUA|AV\.?|AVENIDA|ALAMEDA|TRAVESSA|ROD\.?)\b/i.test(line));
    if (addressBlock > 0) {
      const nearby = lines
        .slice(Math.max(0, addressBlock - 3), addressBlock)
        .reverse()
        .find(line =>
          /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(line) &&
          !/\b(AMAZON|MERCADO|SHOPEE|CORREIOS|BRASIL|FRETE|PEDIDO|ENTREGA|DESTINATARIO|REMETENTE)\b/i.test(normalize(line))
        );
      if (nearby) {
        result.resident = nearby.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ.' -]+$/g, '').trim();
      }
    }
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
  const [ocrSuggestedForm, setOcrSuggestedForm] = useState(null);
  const [residentForm, setResidentForm] = useState(emptyResidentForm);
  const [editingResidentId, setEditingResidentId] = useState(null);
  const [editingParcel, setEditingParcel] = useState(null);
  const [tab, setTab] = useState('desk');
  const [notice, setNotice] = useState({
    text: 'Fotografe a etiqueta ou preencha os dados manualmente.',
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
    return () => { active = false; };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE.memory, JSON.stringify(memory));
    saveAiMemory(memory).catch(error => {
      console.error('Falha ao salvar o backup da IA:', error);
    });
  }, [memory]);

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
    return Object.values(data)
      .flatMap(value => {
        if (Array.isArray(value)) {
          return value.map(entry => `${entry?.label || ''} ${entry?.value || ''}`);
        }
        return [String(value || '')];
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

  function applyLabelText(text, detectedBarcode = '') {
    setOcrText(text);

    if (!text.trim() && !detectedBarcode) {
      setNotice({
        text: 'Nenhum texto ou código de barras foi reconhecido. Tente aproximar e iluminar melhor a etiqueta.',
        type: 'error',
      });
      return;
    }

    const parsed = parseOcrTextSmart(text, memory, residents, detectedBarcode);
    setOcrSuggestedForm(parsed);

    setForm(current => ({
      ...current,
      apartment: parsed.apartment || current.apartment,
      resident: parsed.resident || current.resident,
      barcode: parsed.barcode || current.barcode,
      tracking: parsed.tracking || current.tracking,
      orderNumber: parsed.orderNumber || current.orderNumber,
      invoice: parsed.invoice || current.invoice,
      carrier: parsed.carrier || current.carrier,
    }));

    const matched = Object.values(parsed).filter(Boolean).length;
    setNotice({
      text: matched
        ? `Leitura concluída! ${matched} campo(s) preenchido(s). Se você corrigir algum campo abaixo, a IA aprenderá para a próxima vez.`
        : 'Texto extraído, mas os campos não foram identificados automaticamente. Preencha abaixo para ensinar a IA.',
      type: matched ? 'success' : 'info',
    });
  }

  async function recognizeImage(image) {
    setBusy(true);
    setOcrProgress('Lendo código de barras…');
    setOcrText('');
    setNotice({
      text: 'Analisando etiqueta (código de barras + texto)…',
      type: 'info',
    });

    let worker;

    try {
      const detectedBarcode = await detectBarcodeFromImage(image);
      setOcrProgress('Preparando imagem para OCR…');
      const preparedImage = await prepImageForOcr(image);

      worker = await createWorker('por', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            setOcrProgress(`Lendo texto: ${Math.round((message.progress || 0) * 100)}%`);
          } else if (message.status === 'loading language traineddata') {
            setOcrProgress('Baixando idioma português…');
          }
        },
      });

      const result = await worker.recognize(preparedImage);
      let recognizedText = result.data.text || '';

      if (recognizedText.trim().length < 25) {
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        const retry = await worker.recognize(preparedImage);
        if ((retry.data.text || '').trim().length > recognizedText.trim().length) {
          recognizedText = retry.data.text || recognizedText;
        }
      }

      applyLabelText(recognizedText, detectedBarcode);
    } catch (error) {
      console.error('Falha no OCR:', error);
      setNotice({
        text: 'Erro ao ler a imagem. Tente novamente com boa iluminação ou preencha manualmente.',
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
    } catch {
      setNotice({
        text: 'Câmera cancelada ou sem permissão. Você pode escolher uma foto da galeria.',
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

  function learnFromManualCorrections(rawOcrText, suggested, finalForm) {
    if (!rawOcrText || !rawOcrText.trim()) return;

    const newRules = [];
    const lines = rawOcrText.split(/\r?\n/).map(cleanLine).filter(Boolean);

    if (finalForm.resident.trim() && suggested?.resident && normalize(finalForm.resident) !== normalize(suggested.resident)) {
      if (suggested.resident.length >= 4) {
        newRules.push({
          trigger: suggested.resident,
          field: 'resident',
          targetValue: finalForm.resident.trim(),
          learnedAt: new Date().toISOString(),
        });
      }
    }

    if (finalForm.resident.trim() && !suggested?.resident) {
      const firstWord = normalize(finalForm.resident).split(' ')[0];
      if (firstWord && firstWord.length >= 4) {
        const matchingLine = lines.find(l => normalize(l).includes(firstWord));
        if (matchingLine && matchingLine.length >= 4 && matchingLine.length <= 45) {
          newRules.push({
            trigger: matchingLine,
            field: 'resident',
            targetValue: finalForm.resident.trim(),
            learnedAt: new Date().toISOString(),
          });
        }
      }
    }

    if (finalForm.apartment.trim() && suggested?.apartment && normalize(finalForm.apartment) !== normalize(suggested.apartment)) {
      if (suggested.apartment.length >= 3) {
        newRules.push({
          trigger: suggested.apartment,
          field: 'apartment',
          targetValue: finalForm.apartment.trim(),
          learnedAt: new Date().toISOString(),
        });
      }
    }

    if (finalForm.carrier.trim() && normalize(finalForm.carrier) !== normalize(suggested?.carrier || '')) {
      const candidateWord = normalize(rawOcrText)
        .split(/\s+/)
        .map(w => w.replace(/[^A-Z0-9]/g, ''))
        .find(w => w.length >= 5 && !['DESTINATARIO', 'REMETENTE', 'ENDERECO', 'BAIRRO', 'CIDADE', 'BRASIL'].includes(w));

      if (candidateWord) {
        newRules.push({
          trigger: candidateWord,
          field: 'carrier',
          targetValue: finalForm.carrier.trim(),
          learnedAt: new Date().toISOString(),
        });
      }
    }

    if (newRules.length > 0) {
      setMemory(current => {
        const filtered = current.filter(
          existing => !newRules.some(nr => normalize(nr.trigger) === normalize(existing.trigger) && nr.field === existing.field)
        );
        return [...newRules, ...filtered].slice(0, 250);
      });
    }
  }

  function saveParcel(event) {
    event.preventDefault();

    if (!form.resident.trim() && !form.apartment.trim()) {
      setNotice({
        text: 'Informe pelo menos o destinatário ou o apartamento.',
        type: 'error',
      });
      return;
    }

    learnFromManualCorrections(ocrText, ocrSuggestedForm, form);

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

    setEditingParcel(null);
    setOcrSuggestedForm(null);
    setForm(emptyForm());
    setOcrText('');
    setNotice({
      text: 'Encomenda registrada e padrões de correção salvos na memória da IA.',
      type: 'success',
    });
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
      window.alert(`PDF salvo em Documentos/relatorio de encomendas/${filename}.`);
    } catch {
      doc.save(filename);
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

        <h3>
          {parcel.data.apartment ? `${parcel.data.apartment} — ` : ''}
          {parcel.data.resident || 'Destinatário não informado'}
        </h3>

        {parcel.data.carrier && <p>Transportadora: {parcel.data.carrier}</p>}
        {parcel.data.tracking && <p className="muted">Rastreio: {parcel.data.tracking}</p>}
        {parcel.data.barcode && <p className="muted">Cód. Barras: {parcel.data.barcode}</p>}
        {parcel.data.orderNumber && <p className="muted">Pedido: {parcel.data.orderNumber}</p>}
        {parcel.data.invoice && <p className="muted">NF: {parcel.data.invoice}</p>}

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
                Fotografe a etiqueta. Se corrigir algum campo sugerido, o app aprende automaticamente.
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

                <label className="gallery-button button">
                  <span>Escolher foto</span>
                  <input type="file" accept="image/*" onChange={chooseImage} />
                </label>
              </div>

              <div className={`notice ${notice.type}`} role="status" aria-live="polite">
                {busy && ocrProgress ? `${notice.text} ${ocrProgress}` : notice.text}
              </div>

              {!!ocrText && (
                <div className="ocr-result">
                  <label className="field-label" htmlFor="ocr-text">Texto bruto lido da etiqueta</label>
                  <textarea
                    id="ocr-text"
                    className="ocr-textarea"
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
                      placeholder="Confira ou complete os dados"
                    />
                  </label>
                ))}

                <div className="section-heading extra-heading">
                  <h3>Detalhes adicionais da etiqueta</h3>
                </div>

                {(form.extraDetails || []).map((detail, index) => (
                  <div key={detail.id || index} className="extra-detail-row">
                    <label className="field-label">
                      Campo
                      <input
                        placeholder="Ex: Bloco, Obs..."
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
                        placeholder="Informação"
                        value={detail.value || ''}
                        onChange={event => {
                          const next = [...(form.extraDetails || [])];
                          next[index].value = event.target.value;
                          updateField('extraDetails', next);
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      className="button small red"
                      onClick={() => {
                        const next = (form.extraDetails || []).filter((_, i) => i !== index);
                        updateField('extraDetails', next);
                      }}
                    >
                      Remover
                    </button>
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
                  + Adicionar informação extra
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
                placeholder="Buscar por nome, apto, rastreio, pedido ou NF"
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
                      return normalize(`${resident.name} ${resident.apartment} ${resident.phone}`).includes(term);
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
              No Android, os arquivos ficam em Documentos/relatorio de encomendas.
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
            <h2>Memória da IA (Aprendizado OCR)</h2>
            <p className="help-text">
              Padrões aprendidos automaticamente quando você corrige uma leitura da câmera ({memory.length} regras salvas).
            </p>

            {memory.length ? (
              memory.map((item, idx) => (
                <div className="memory-row" key={idx}>
                  <span>
                    Quando ler: <strong>{item.trigger || item.keyword}</strong>
                  </span>
                  <strong>→ {item.targetValue || item.carrier}</strong>
                </div>
              ))
            ) : (
              <p className="empty">Nenhuma correção aprendida ainda. Corrija uma etiqueta lida pela câmera para treinar.</p>
            )}
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
          <span>🧠</span>IA ({memory.length})
        </button>
      </nav>
    </div>
  );
}
