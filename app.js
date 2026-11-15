const KEYS = {
  residents: 'portaria_residents',
  parcels: 'portaria_parcels',
  fields: 'portaria_fields',
  memory: 'portaria_ai_memory'
};

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
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

const state = {
  residents: read(KEYS.residents, []),
  parcels: read(KEYS.parcels, {}),
  fields: read(KEYS.fields, DEFAULT_FIELDS),
  memory: read(KEYS.memory, DEFAULT_MEMORY),
  ocrText: '',
  residentPhoto: '',
  family: [],
  editingParcel: null
};

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function currentDate() {
  return new Date().toLocaleDateString('pt-BR');
}

function clock() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function status(message, kind = 'info') {
  const el = document.getElementById('ocr-status');
  if (!el) return;
  el.className = `notice ${kind}`;
  el.textContent = message;
}

function buttonText(text, className, handler) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.className = className;
  btn.addEventListener('click', handler);
  return btn;
}

function renderForm() {
  const root = document.getElementById('parcel-fields');
  if (!root) return;
  root.replaceChildren();

  state.fields.forEach((field) => {
    const label = document.createElement('label');
    label.textContent = field.title;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `field-${field.id}`;
    input.placeholder = 'Confira e complete os dados';
    root.append(label, input);
  });
}

function todayParcels() {
  return state.parcels[dayKey()] || [];
}

function renderParcels() {
  const root = document.getElementById('parcel-list');
  if (!root) return;
  root.replaceChildren();

  const list = todayParcels();
  if (!list.length) {
    root.innerHTML = '<p class="empty">Nenhuma encomenda registrada hoje.</p>';
    return;
  }

  list.forEach((parcel, index) => {
    const card = document.createElement('article');
    card.className = 'item';

    const badge = document.createElement('span');
    badge.className = `badge ${parcel.status === 'Retirado' ? 'badge-done' : 'badge-wait'}`;
    badge.textContent = parcel.status;

    const details = document.createElement('div');
    details.className = 'details';

    Object.entries(parcel.data).forEach(([key, value]) => {
      if (!value) return;
      const row = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `${key}: `;
      row.append(strong, document.createTextNode(value));
      details.appendChild(row);
    });

    const time = document.createElement('p');
    time.textContent = `Recebido: ${parcel.receivedAt}${parcel.leftAt ? ` • Retirado: ${parcel.leftAt} por ${parcel.pickedUpBy}` : ''}`;
    details.appendChild(time);

    card.append(badge, details);

    if (parcel.status !== 'Retirado') {
      card.append(buttonText('Dar saída', 'button small green', () => {
        const person = prompt('Quem retirou a encomenda?');
        if (!person || !person.trim()) return;

        parcel.status = 'Retirado';
        parcel.pickedUpBy = person.trim();
        parcel.leftAt = clock();

        save(KEYS.parcels, state.parcels);
        render();
      }));
    }

    card.append(buttonText('Editar', 'button small amber', () => {
      state.editingParcel = index;
      state.fields.forEach((field) => {
        const input = document.getElementById(`field-${field.id}`);
        if (input) input.value = parcel.data[field.title] || '';
      });
      document.getElementById('save-parcel').textContent = 'Atualizar encomenda';
      goTo('desk');
      window.scrollTo(0, 0);
    }));

    card.append(buttonText('Excluir', 'button small red', () => {
      if (!confirm('Excluir esta encomenda?')) return;
      state.parcels[dayKey()].splice(index, 1);
      save(KEYS.parcels, state.parcels);
      render();
    }));

    root.appendChild(card);
  });
}

function renderResidents() {
  const root = document.getElementById('resident-list');
  if (!root) return;
  root.replaceChildren();

  if (!state.residents.length) {
    root.innerHTML = '<p class="empty">Nenhum morador cadastrado.</p>';
    return;
  }

  state.residents.forEach((resident, index) => {
    const card = document.createElement('article');
    card.className = 'item';

    const title = document.createElement('strong');
    title.textContent = `${resident.apartment} — ${resident.name}`;

    const meta = document.createElement('p');
    meta.className = 'details';
    meta.textContent = `WhatsApp: ${resident.phone || '—'} • Familiares: ${(resident.family || []).length}`;

    card.append(title, meta);

    card.append(buttonText('Editar', 'button small amber', () => editResident(index)));
    card.append(buttonText('Excluir', 'button small red', () => {
      if (!confirm('Excluir este morador?')) return;
      state.residents.splice(index, 1);
      save(KEYS.residents, state.residents);
      render();
    }));

    root.appendChild(card);
  });
}

function editResident(index) {
  const resident = state.residents[index];
  document.getElementById('resident-index').value = index;
  document.getElementById('resident-name').value = resident.name;
  document.getElementById('resident-apartment').value = resident.apartment;
  document.getElementById('resident-phone').value = resident.phone || '';
  state.residentPhoto = resident.photo || '';
  state.family = structuredClone(resident.family || []);

  const preview = document.getElementById('resident-preview');
  preview.src = state.residentPhoto;
  preview.hidden = !state.residentPhoto;

  renderFamily();
  document.getElementById('resident-form-title').textContent = 'Editar morador';
  goTo('residents');
  window.scrollTo(0, 0);
}

function renderFamily() {
  const root = document.getElementById('family-list');
  if (!root) return;
  root.replaceChildren();

  state.family.forEach((person, index) => {
    const card = document.createElement('div');
    card.className = 'item';

    const nameLabel = document.createElement('label');
    nameLabel.textContent = `Nome do familiar ${index + 1}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = person.name || '';
    nameInput.addEventListener('input', () => {
      state.family[index].name = nameInput.value;
    });

    const relationLabel = document.createElement('label');
    relationLabel.textContent = 'Parentesco';

    const relationInput = document.createElement('input');
    relationInput.type = 'text';
    relationInput.value = person.relation || '';
    relationInput.addEventListener('input', () => {
      state.family[index].relation = relationInput.value;
    });

    card.append(nameLabel, nameInput, relationLabel, relationInput);
    root.appendChild(card);
  });
}

function renderSettings() {
  const root = document.getElementById('field-settings');
  if (!root) return;
  root.replaceChildren();

  state.fields.forEach((field, index) => {
    const row = document.createElement('div');
    row.className = 'item';

    const title = document.createElement('strong');
    title.textContent = field.title;

    const info = document.createElement('small');
    info.textContent = `Palavra-chave: ${field.keyword || 'nenhuma'}`;

    row.append(title, info);

    if (index >= DEFAULT_FIELDS.length) {
      row.append(buttonText('Remover', 'button small red', () => {
        state.fields.splice(index, 1);
        save(KEYS.fields, state.fields);
        render();
      }));
    }

    root.appendChild(row);
  });

  const memoryRoot = document.getElementById('ai-memory');
  if (!memoryRoot) return;
  memoryRoot.replaceChildren();

  state.memory.slice(0, 20).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.textContent = `${entry.word} → ${entry.value}`;
    memoryRoot.appendChild(row);
  });
}

function renderReports() {
  const root = document.getElementById('report-list');
  if (!root) return;
  root.replaceChildren();

  const days = Object.keys(state.parcels).sort().reverse();
  if (!days.length) {
    root.innerHTML = '<p class=\"empty\">Ainda não há relatórios.</p>';
    return;
  }

  days.forEach((day) => {
    const card = document.createElement('article');
    card.className = 'item';
    card.append(document.createTextNode(`${day}: ${(state.parcels[day] || []).length} registros`));
    card.append(buttonText('Baixar PDF', 'button small green', () => exportPdf(day)));
    root.appendChild(card);
  });
}

function render() {
  renderForm();
  renderParcels();
  renderResidents();
  renderSettings();
  renderReports();
}

function parseOcr(text) {
  const upper = text.toLocaleUpperCase('pt-BR');
  const lines = text.split(/\r?\n/);

  state.fields.forEach((field) => {
    const input = document.getElementById(`field-${field.id}`);
    if (input) input.value = '';
  });

  state.memory.forEach((rule) => {
    if (!upper.includes(rule.word.toLocaleUpperCase('pt-BR'))) return;
    const target = document.getElementById(`field-${rule.field}`);
    if (target && !target.value) target.value = rule.value;
  });

  state.fields.forEach((field) => {
    const input = document.getElementById(`field-${field.id}`);
    if (!input || input.value || !field.keyword) return;

    const lineIndex = lines.findIndex((line) => line.toLocaleUpperCase('pt-BR').includes(field.keyword.toLocaleUpperCase('pt-BR')));
    if (lineIndex < 0) return;

    const currentLine = lines[lineIndex];
    const pos = currentLine.toLocaleUpperCase('pt-BR').indexOf(field.keyword.toLocaleUpperCase('pt-BR'));
    const value = currentLine.slice(pos + field.keyword.length).replace(/^[:\\s-]+/, '').trim();

    input.value = value || (lines[lineIndex + 1] || '').trim();
  });

  const apartmentField = document.getElementById('field-apartment');
  if (apartmentField && !apartmentField.value) {
    const match = upper.match(/(?:APTO|APT|APARTAMENTO|BLOCO)\\s*[:#-]?\\s*([0-9A-Z]+)/);
    if (match) apartmentField.value = `Apto ${match[1]}`;
  }

  const residentMatch = document.getElementById('resident-match');
  if (residentMatch) {
    residentMatch.hidden = true;
    residentMatch.textContent = '';
  }

  const matchedResident = state.residents.find((resident) => {
    if (resident.name && upper.includes(resident.name.toLocaleUpperCase('pt-BR'))) return true;

    return (resident.family || []).some((relative) => relative.name && upper.includes(relative.name.toLocaleUpperCase('pt-BR')));
  });

  if (matchedResident) {
    const relative = (matchedResident.family || []).find((person) => person.name && upper.includes(person.name.toLocaleUpperCase('pt-BR')));

    const residentField = document.getElementById('field-resident');
    const apartmentField = document.getElementById('field-apartment');
    if (residentField) residentField.value = relative ? `${relative.name} (${relative.relation || 'Familiar'})` : matchedResident.name;
    if (apartmentField) apartmentField.value = matchedResident.apartment;

    if (residentMatch) {
      residentMatch.hidden = false;
      residentMatch.textContent = `Cadastro encontrado: ${matchedResident.apartment} — ${matchedResident.name}`;
      residentMatch.classList.remove('hidden');
    }
  }
}

async function processImage(fileOrDataUrl) {
  status('Lendo etiqueta com OCR. Aguarde…', 'info');
  if (!window.Tesseract) {
    status('Biblioteca OCR não carregada. Verifique a conexão e preencha manualmente.', 'error');
    return;
  }

  try {
    const result = await Tesseract.recognize(fileOrDataUrl, 'por');
    state.ocrText = result.data.text || '';
    parseOcr(state.ocrText);
    status('Leitura concluída. Confira os dados antes de salvar.', 'success');
  } catch (error) {
    console.error(error);
    status('Falha na leitura. Tente outra foto ou preencha manualmente.', 'error');
  }
}

function saveParcel() {
  const data = {};
  state.fields.forEach((field) => {
    const input = document.getElementById(`field-${field.id}`);
    data[field.title] = input?.value.trim() || '';
  });

  if (!data['Nome do morador'] && !data['Apartamento / bloco']) {
    status('Informe o morador ou apartamento para continuar.', 'error');
    return;
  }

  const day = dayKey();
  state.parcels[day] ||= [];

  if (state.editingParcel !== null) {
    state.parcels[day][state.editingParcel].data = data;
    state.editingParcel = null;
    document.getElementById('save-parcel').textContent = 'Registrar recebimento';
  } else {
    state.parcels[day].unshift({
      receivedAt: clock(),
      leftAt: '',
      pickedUpBy: '',
      status: 'Pendente',
      data
    });
  }

  if (state.ocrText && data['Transportadora']) {
    const words = state.ocrText.toUpperCase().split(/\\s+/).map((token) => token.replace(/[^A-Z0-9]/g, ''));
    const candidate = words.find((token) => token.length >= 5 && token !== 'DESTINATARIO' && token !== 'REMETENTE');
    if (candidate) {
      state.memory.unshift({ word: candidate, field: 'carrier', value: data['Transportadora'] });
    }
  }

  save(KEYS.parcels, state.parcels);
  save(KEYS.memory, state.memory);

  state.ocrText = '';
  status('Encomenda registrada com sucesso.', 'success');
  render();
}

function exportPdf(day) {
  if (!window.jspdf) {
    alert('Biblioteca PDF indisponível. Verifique a conexão.');
    return;
  }

  const doc = new window.jspdf.jsPDF();
  doc.setFontSize(15);
  doc.text(`Relatório de encomendas — ${day}`, 14, 18);
  doc.setFontSize(10);

  let y = 30;

  (state.parcels[day] || []).forEach((parcel, index) => {
    const details = Object.entries(parcel.data).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' | ');
    const lines = doc.splitTextToSize(`${index + 1}. ${parcel.status} | Entrada: ${parcel.receivedAt}${parcel.leftAt ? ` | Saída: ${parcel.leftAt} (${parcel.pickedUpBy})` : ''} | ${details}`, 180);

    if (y + lines.length * 6 > 280) {
      doc.addPage();
      y = 20;
    }

    doc.text(lines, 14, y);
    y += lines.length * 6 + 4;
  });

  doc.save(`encomendas-${day}.pdf`);
}

function saveResident() {
  const name = document.getElementById('resident-name').value.trim();
  const apartment = document.getElementById('resident-apartment').value.trim();
  const phone = document.getElementById('resident-phone').value.trim();
  const index = Number.parseInt(document.getElementById('resident-index').value, 10);

  if (!name || !apartment) {
    alert('Informe o nome e o apartamento do morador.');
    return;
  }

  const resident = {
    name,
    apartment,
    phone,
    photo: state.residentPhoto,
    family: state.family
  };

  if (index >= 0) {
    state.residents[index] = resident;
  } else {
    state.residents.unshift(resident);
  }

  save(KEYS.residents, state.residents);

  document.getElementById('resident-index').value = '-1';
  document.getElementById('resident-form-title').textContent = 'Cadastrar morador';
  document.getElementById('resident-name').value = '';
  document.getElementById('resident-apartment').value = '';
  document.getElementById('resident-phone').value = '';
  document.getElementById('resident-preview').hidden = true;
  state.residentPhoto = '';
  state.family = [];
  renderFamily();
  render();
  alert('Cadastro salvo.');
}

function bindEvents() {
  document.getElementById('nav-desk').addEventListener('click', () => goTo('desk'));
  document.getElementById('nav-residents').addEventListener('click', () => goTo('residents'));
  document.getElementById('nav-settings').addEventListener('click', () => goTo('settings'));
  document.getElementById('nav-reports').addEventListener('click', () => goTo('reports'));

  document.getElementById('open-residents').addEventListener('click', () => goTo('residents'));
  document.getElementById('open-camera').addEventListener('click', async () => {
    const camera = window.Capacitor?.Plugins?.Camera;

    if (!camera) {
      document.getElementById('label-photo').click();
      return;
    }

    try {
      const photo = await camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: 'dataUrl',
        source: 'CAMERA'
      });

      if (photo && photo.dataUrl) {
        processImage(photo.dataUrl);
      }
    } catch (error) {
      alert('Câmera fechada ou sem permissão.');
    }
  });

  document.getElementById('label-photo').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) processImage(file);
    event.target.value = '';
  });

  document.getElementById('resident-photo').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 140 / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        state.residentPhoto = canvas.toDataURL('image/jpeg', 0.7);
        document.getElementById('resident-preview').src = state.residentPhoto;
        document.getElementById('resident-preview').hidden = false;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('save-parcel').addEventListener('click', saveParcel);
  document.getElementById('save-resident').addEventListener('click', saveResident);
  document.getElementById('add-family').addEventListener('click', () => {
    state.family.push({ name: '', relation: '' });
    renderFamily();
  });

  document.getElementById('add-field').addEventListener('click', () => {
    const title = document.getElementById('new-field-title').value.trim();
    const keyword = document.getElementById('new-field-keyword').value.trim();

    if (!title) {
      alert('Digite o nome do campo.');
      return;
    }

    state.fields.push({ id: `custom-${Date.now()}`, title, keyword });
    save(KEYS.fields, state.fields);
    document.getElementById('new-field-title').value = '';
    document.getElementById('new-field-keyword').value = '';
    render();
  });
}

function goTo(tab) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('shown'));
  document.querySelectorAll('.navigation button').forEach((el) => el.classList.remove('selected'));
  document.getElementById(`screen-${tab}`)?.classList.add('shown');
  document.getElementById(`nav-${tab}`)?.classList.add('selected');
}

window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  render();
});
