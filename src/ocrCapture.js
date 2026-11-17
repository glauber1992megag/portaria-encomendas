import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { createWorker } from 'tesseract.js';

const FIELD_IDS = {
  resident: 'Nome do morador',
  apartment: 'Apartamento / bloco',
  carrier: 'Transportadora',
  tracking: 'Código / observações',
};

const CARRIERS = [
  ['AMAZON', 'Amazon'],
  ['MERCADO LIVRE', 'Mercado Livre'],
  ['MERCADOLIVRE', 'Mercado Livre'],
  ['SHOPEE', 'Shopee'],
  ['CORREIOS', 'Correios'],
  ['MAGALU', 'Magalu Entregas'],
];

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR');
}

function setInputValue(input, value) {
  if (!input || !value) return;

  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
  setter?.call(input, value);

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findFieldInput(labelText) {
  const labels = [...document.querySelectorAll('label.field-label')];
  const label = labels.find(element => element.firstChild?.textContent?.trim() === labelText);
  return label?.querySelector('input, textarea');
}

function parseLabel(text) {
  const normalized = normalize(text);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const result = {};

  const findLabeled = labels => {
    for (let i = 0; i < lines.length; i += 1) {
      const current = normalize(lines[i]);
      const key = labels.find(label => current.includes(normalize(label)));
      if (!key) continue;

      const index = current.indexOf(normalize(key));
      const rest = lines[i]
        .slice(index + key.length)
        .replace(/^\s*[:#-]?\s*/, '')
        .trim();

      if (rest.length > 1) return rest;
      if (lines[i + 1]) return lines[i + 1];
    }

    return '';
  };

  result.apartment = findLabeled(['APARTAMENTO', 'APTO', 'APT.', 'APT ']);
  const aptMatch = normalized.match(/\b(?:APTO|APT)\.?\s*[:#-]?\s*(\d{1,5}[A-Z]?)\b/);
  if (aptMatch) result.apartment = aptMatch[1];

  result.resident = findLabeled(['DESTINATARIO', 'RECEBEDOR', 'CLIENTE', 'DESTINO']);
  if (!result.resident) {
    const addressLineIndex = lines.findIndex(line =>
      /\b(RUA|AV\.?|AVENIDA|ALAMEDA|TRAVESSA)\b/i.test(line)
    );

    if (addressLineIndex > 0) {
      const candidate = lines
        .slice(Math.max(0, addressLineIndex - 3), addressLineIndex)
        .reverse()
        .find(line =>
          /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(line) &&
          !/\b(AMAZON|BRASIL|FRETE|GRATIS|RAPIDO|PEDIDO|ENTREGA)\b/i.test(normalize(line))
        );

      if (candidate) {
        result.resident = candidate
          .replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ.' -]+$/g, '')
          .trim();
      }
    }
  }

  const carrier = CARRIERS.find(([hint]) => normalized.includes(hint));
  result.carrier = carrier?.[1] || findLabeled(['TRANSPORTADORA']);

  const tracking = normalized.match(/\b([A-Z]{2,5}\d{6,}[A-Z0-9]*)\b/);
  result.tracking =
    tracking?.[1] || findLabeled(['RASTREAMENTO', 'RASTREIO', 'TRACKING', 'CODIGO DO OBJETO', 'OBJETO']);

  return result;
}

async function makeOcrImage(input) {
  let objectUrl;
  const source = input instanceof Blob ? (objectUrl = URL.createObjectURL(input)) : input;

  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Não foi possível abrir a foto.'));
      element.src = source;
    });

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const scale = Math.min(1.7, 2200 / Math.max(width, height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível para preparar a imagem.');

    context.filter = 'grayscale(1) contrast(1.6)';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/png');
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function showStatus(message, type = 'info') {
  const status = document.querySelector('.notice[role="status"]');
  if (status) {
    status.className = `notice ${type}`;
    status.setAttribute('aria-live', 'polite');
    status.textContent = message;
  }
}

async function recognizeAndApply(image) {
  let worker;

  try {
    showStatus(
      'Preparando a foto. Na primeira leitura, conecte à internet para baixar o idioma português.',
      'info'
    );

    const prepared = await makeOcrImage(image);

    worker = await createWorker('por', 1, {
      logger: message => {
        if (message.status === 'recognizing text') {
          showStatus(`Lendo etiqueta: ${Math.round((message.progress || 0) * 100)}%`, 'info');
        } else if (message.status === 'loading language traineddata') {
          showStatus('Baixando idioma português…', 'info');
        }
      },
    });

    const first = await worker.recognize(prepared, {}, { blocks: true });
    let bestText = first.data.text || '';
    let bestScore = first.data.confidence || 0;

    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const retry = await worker.recognize(prepared, {}, { blocks: true });

    if ((retry.data.confidence || 0) > bestScore || (retry.data.text || '').length > bestText.length * 1.15) {
      bestText = retry.data.text || bestText;
    }

    const parsed = parseLabel(bestText);

    setInputValue(findFieldInput(FIELD_IDS.resident), parsed.resident);
    setInputValue(findFieldInput(FIELD_IDS.apartment), parsed.apartment);
    setInputValue(findFieldInput(FIELD_IDS.carrier), parsed.carrier);
    setInputValue(findFieldInput(FIELD_IDS.tracking), parsed.tracking);

    const rawText = document.querySelector('#ocr-text');
    if (rawText) {
      setInputValue(rawText, bestText);
    }

    const suggestions = Object.values(parsed).filter(Boolean).length;
    const summaryMessage = bestText.trim()
      ? `${suggestions} campo(s) sugerido(s). Confira o nome, apartamento e código; fotos com mais de uma etiqueta podem misturar os textos.`
      : 'Não consegui identificar os campos automaticamente. Aproxime a câmera de uma única etiqueta e tente novamente.';

    showStatus(summaryMessage, suggestions ? 'success' : 'error');
  } catch (error) {
    console.error('Falha no OCR:', error);
    showStatus(
      'Falha no OCR. Fotografe uma única etiqueta, bem iluminada e de frente; confira também a conexão na primeira leitura.',
      'error'
    );
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

export function enableOcrCapture() {
  const root = document.getElementById('root') || document.body;

  const onClick = event => {
    const button = event.target.closest('.camera-button');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (button.disabled) return;

    button.disabled = true;
    showStatus('Abrindo câmera…', 'info');

    Camera.getPhoto({
      quality: 95,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
      correctOrientation: true,
    })
      .then(photo => photo.dataUrl && recognizeAndApply(photo.dataUrl))
      .catch(() => {
        showStatus('Câmera cancelada ou sem permissão. Você pode escolher uma foto da galeria.', 'error');
      })
      .finally(() => {
        button.disabled = false;
      });
  };

  const onChange = event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.closest('.gallery-button')) return;

    event.stopPropagation();
    event.stopImmediatePropagation();

    const file = input.files?.[0];
    input.value = '';

    if (file) {
      recognizeAndApply(file);
    }
  };

  root.addEventListener('click', onClick, true);
  root.addEventListener('change', onChange, true);

  return () => {
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('change', onChange, true);
  };
}
